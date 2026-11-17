// Databases view of the admin tab against the dev PostgreSQL: lists the databases with the
// current one marked and the server's own dimmed, creates a database (the preview, what the
// server refuses), changes its comment and limit and renames it (the encoding is refused with
// the server's reason), drops it only after its name is typed exactly, and offers nothing to
// change on a read-only connection.
import { DBS, assert, needs, sh } from "../grid-helpers.mjs";
import { adminTab, openAdmin, showSection } from "../admin.mjs";
import {
  canRun,
  cancelDialog,
  dialog,
  inDialog,
  openDialog,
  runDialog,
  setField,
  setValue,
  usersConnections,
  waitPreview,
} from "../admin-users.mjs";

const DB = "pg";
const NAME = "QA V PostgreSQL";
const RO_NAME = "QA V PostgreSQL read-only";
const NEW = "e2e_dbm_new";
const RENAMED = "e2e_dbm_renamed";

export const skip = needs(DB);

const cleanup = () => sh(DB, `DROP DATABASE IF EXISTS ${NEW} WITH (FORCE); DROP DATABASE IF EXISTS ${RENAMED} WITH (FORCE);`);

export function setup({ dir }) {
  usersConnections(dir, [[NAME, DB], [RO_NAME, DB, "read_only = true\n"]], DBS);
}

const view = `${adminTab}.querySelector('[data-view="databases"]')`;
const row = (name) => `${view}?.querySelector('tr.admin-database[data-name="${name}"]')`;
const button = (action) => `${view}.querySelector('button[data-action="${action}"]')`;
const errorText = (page) => page.eval(`${inDialog('[data-field="run-error"]')}?.textContent ?? null`);

async function openDatabases(page, name) {
  await openAdmin(page, name, DB);
  await showSection(page, "Databases");
  await page.waitFor(`${view} !== null && ${view}.querySelector('tr.admin-database') !== null`, 20_000);
}

async function select(page, name) {
  await page.waitFor(`${row(name)} !== null`, 15_000);
  await page.eval(`${row(name)}.click()`);
  await page.waitFor(`${row(name)}.classList.contains('selected')`, 10_000);
}

/** The list: the current database marked, the server's own dimmed and not droppable. */
async function checkList(page) {
  assert.equal(await page.eval(`${view}.querySelectorAll('tr.admin-database[data-current="true"]').length`), 1);
  assert.equal(await page.eval(`${row("postgres")}.dataset.system`), "true");
  // Nothing selected: nothing to edit or drop.
  assert.equal(await page.eval(`${button("edit")}.disabled`), true);
  assert.equal(await page.eval(`${button("drop")}.disabled`), true);
  await select(page, "postgres");
  assert.equal(await page.eval(`${button("edit")}.disabled`), false);
  assert.equal(await page.eval(`${button("drop")}.disabled`), true, "a system database cannot be dropped");
  const current = await page.eval(`${view}.querySelector('tr.admin-database[data-current="true"]').dataset.name`);
  await select(page, current);
  assert.equal(await page.eval(`${button("drop")}.disabled`), true, "the current database cannot be dropped");

  // The filter narrows the list; nothing matching says so.
  const search = '[data-view="databases"] input[type=search]';
  await setValue(page, search, "nothing-like-this");
  await page.waitFor(`${view}.querySelector('.admin-empty')?.textContent === 'No databases match.'`);
  await setValue(page, search, "");
  await page.waitFor(`${view}.querySelector('.admin-empty') === null`);
}

/** New: what stops it, the preview, the server's refusal of a name that exists, the result. */
async function create(page) {
  await openDialog(page, button("new"));
  assert.match(await waitPreview(page, "Type a name."), /Type a name\./);
  assert.equal(await canRun(page), false);
  await setField(page, "limit", "abc");
  await setField(page, "name", NEW);
  await waitPreview(page, "The connection limit is a whole number.");
  assert.equal(await canRun(page), false);
  await setField(page, "limit", "5");
  await setField(page, "comment", "made by the e2e");
  const shown = await waitPreview(page, "CONNECTION LIMIT");
  assert.ok(shown.includes(`CREATE DATABASE ${NEW}`), shown);
  assert.ok(shown.includes("CONNECTION LIMIT 5"), shown);

  // A name that exists: the server's refusal shows in the dialog, which stays open.
  await setField(page, "name", "postgres");
  await waitPreview(page, "CREATE DATABASE postgres");
  await page.eval(`${inDialog('button[data-action="run"]')}.click()`);
  await page.waitFor(`${inDialog('[data-field="run-error"]')} !== null`, 15_000);
  assert.match(await errorText(page), /already exists/);
  await setField(page, "name", NEW);
  await waitPreview(page, `CREATE DATABASE ${NEW}`);
  await runDialog(page);

  await page.waitFor(`${row(NEW)} !== null`, 15_000);
  assert.equal(sh(DB, `SELECT datconnlimit FROM pg_database WHERE datname = '${NEW}'`), "5");
  assert.equal(sh(DB, `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${NEW}'`), "made by the e2e");
  assert.equal(await page.eval(`${row(NEW)}.querySelector('.admin-query').textContent`), "made by the e2e");
}

/** Edit: the form starts from the database, nothing to change cannot run, the encoding is
 *  refused with the server's reason, then comment, limit and a rename go through. */
async function edit(page) {
  await select(page, NEW);
  await openDialog(page, button("edit"));
  assert.equal(await page.eval(inDialog('[data-field="name"]') + ".disabled"), true);
  assert.equal(await page.eval(inDialog('[data-field="limit"]') + ".value"), "5");
  assert.equal(await page.eval(inDialog('[data-field="comment"]') + ".value"), "made by the e2e");
  await page.waitFor(`${inDialog('[data-field="preview-error"]')} !== null`, 10_000);
  assert.equal(await canRun(page), false, "nothing to change");

  await setField(page, "encoding", "LATIN1");
  await page.waitFor(`${inDialog('[data-field="preview-error"]')}?.textContent.length > 0`, 10_000);
  assert.equal(await canRun(page), false, "an encoding change is refused");
  await setField(page, "encoding", await page.eval(`${row(NEW)}.children[2].textContent`));

  await setField(page, "comment", "changed by the e2e");
  await setField(page, "limit", "");
  await setField(page, "rename-to", RENAMED);
  const shown = await waitPreview(page, "RENAME TO");
  assert.ok(shown.includes(`ALTER DATABASE ${NEW} CONNECTION LIMIT -1`) || shown.includes("CONNECTION LIMIT -1"), shown);
  assert.ok(shown.includes(`RENAME TO ${RENAMED}`), shown);
  await runDialog(page);

  await page.waitFor(`${row(RENAMED)} !== null && ${row(NEW)} === null`, 15_000);
  assert.equal(sh(DB, `SELECT datconnlimit FROM pg_database WHERE datname = '${RENAMED}'`), "-1");
  assert.equal(await page.eval(`${row(RENAMED)}.querySelector('.admin-query').textContent`), "changed by the e2e");
}

/** Drop: the button stays off until the name is typed exactly. */
async function drop(page) {
  await select(page, RENAMED);
  await openDialog(page, button("drop"));
  assert.ok((await waitPreview(page, "DROP DATABASE")).includes(`DROP DATABASE ${RENAMED}`));
  assert.equal(await canRun(page), false);
  await setField(page, "confirm", "e2e_dbm_renam");
  assert.equal(await canRun(page), false, "a part of the name");
  await setField(page, "confirm", RENAMED.toUpperCase());
  assert.equal(await canRun(page), false, "another case");
  await setField(page, "confirm", `${RENAMED} `);
  assert.equal(await canRun(page), false, "a trailing space");
  // Cancelling drops nothing.
  await cancelDialog(page);
  assert.equal(sh(DB, `SELECT count(*) FROM pg_database WHERE datname = '${RENAMED}'`), "1");

  await openDialog(page, button("drop"));
  await waitPreview(page, `DROP DATABASE ${RENAMED}`);
  await page.eval(`${inDialog('input[data-field="force"]')}?.click()`);
  await setField(page, "confirm", RENAMED);
  await page.waitFor(`${inDialog('button[data-action="run"]')}.disabled === false`, 10_000);
  await runDialog(page);
  await page.waitFor(`${row(RENAMED)} === null`, 15_000);
  assert.equal(sh(DB, `SELECT count(*) FROM pg_database WHERE datname = '${RENAMED}'`), "0");
}

export default async function (page) {
  cleanup();
  try {
    await openDatabases(page, NAME);
    await checkList(page);
    await create(page);
    await edit(page);
    await drop(page);

    // A read-only connection lists the databases and changes nothing.
    await openDatabases(page, RO_NAME);
    assert.equal(await page.eval(`${button("new")}.disabled`), true);
    await select(page, "postgres");
    assert.equal(await page.eval(`${button("edit")}.disabled`), true);
    assert.equal(await page.eval(`${button("drop")}.disabled`), true);
    assert.equal(await page.eval(`${button("new")}.title`), "The connection is read-only");
    assert.equal(await page.eval(`${dialog}`), null);
  } finally {
    cleanup();
  }
}
