// Unit tests of the permission matrix's pure model (src/admin/permissionMatrixModel.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChanges, cellId, heldColumns, isChecked, matchesPrincipal, onDatabase, principalKey, rebaseEdits, toggleCell, toggleEdit } from "../src/admin/permissionMatrixModel.ts";

const grant = (over = {}) => ({ kind: "database", schema: "shop", object: null, column: null, privilege: "CONNECT", grantable: false, ...over });
const user = (name, host = null) => ({ name, host, kind: "user", flags: [], member_of: [] });
const COLUMNS = ["CONNECT", "CREATE", "TEMPORARY"];

test("onDatabase matches only database grants on that name", () => {
  assert.equal(onDatabase(grant(), "shop"), true);
  assert.equal(onDatabase(grant(), "other"), false);
  assert.equal(onDatabase(grant({ kind: "schema" }), "shop"), false);
  assert.equal(onDatabase(grant({ kind: "table", object: "shop" }), "shop"), false);
  assert.equal(onDatabase(grant({ schema: "my\\_db" }), "my_db"), true);
  assert.equal(onDatabase(grant({ schema: null, object: "shop" }), "shop"), true);
  assert.equal(onDatabase(grant({ schema: null }), "shop", true), true, "SQL Server names no database");
});

test("heldColumns reads the grants on the database, case-insensitively", () => {
  const grants = [grant(), grant({ privilege: "create" }), grant({ schema: "other", privilege: "TEMPORARY" }), grant({ kind: "server", schema: null, privilege: "TEMPORARY" })];
  assert.deepEqual([...heldColumns(grants, "shop", COLUMNS)].sort(), ["CONNECT", "CREATE"]);
  assert.deepEqual([...heldColumns([], "shop", COLUMNS)], []);
});

test("heldColumns derives ALL from ALL or from every privilege", () => {
  const cols = [...COLUMNS, "ALL"];
  assert.ok(heldColumns([grant({ privilege: "ALL PRIVILEGES" })], "shop", cols).has("ALL"));
  const every = COLUMNS.map((privilege) => grant({ privilege }));
  assert.ok(heldColumns(every, "shop", cols).has("ALL"));
  assert.ok(!heldColumns(every.slice(1), "shop", cols).has("ALL"));
  assert.ok(!heldColumns([grant()], "shop", COLUMNS).has("ALL"), "no ALL column, none held");
});

test("toggleEdit flips a cell in and out of the edits", () => {
  const id = cellId("a@", "CONNECT");
  const one = toggleEdit(new Set(), id);
  assert.ok(one.has(id));
  assert.equal(toggleEdit(one, id).size, 0);
});

test("isChecked is what the server has, flipped when edited", () => {
  const base = new Map([["a@", new Set(["CONNECT"])], ["b@", null]]);
  const edits = new Set([cellId("a@", "CONNECT"), cellId("a@", "CREATE")]);
  assert.equal(isChecked(base, edits, "a@", "CONNECT"), false);
  assert.equal(isChecked(base, edits, "a@", "CREATE"), true);
  assert.equal(isChecked(base, edits, "a@", "TEMPORARY"), false);
  assert.equal(isChecked(base, new Set(), "b@", "CONNECT"), false);
});

test("buildChanges groups by principal and action, revokes first", () => {
  const a = user("alice");
  const b = user("bob", "%");
  const base = new Map([[principalKey(a), new Set(["CONNECT", "CREATE"])], [principalKey(b), new Set()]]);
  const edits = new Set([
    cellId(principalKey(a), "CONNECT"),
    cellId(principalKey(a), "CREATE"),
    cellId(principalKey(a), "TEMPORARY"),
    cellId(principalKey(b), "CONNECT"),
  ]);
  const changes = buildChanges([b, a], base, edits, "shop", COLUMNS);
  assert.deepEqual(changes.map((c) => [c.action, c.grantees[0].name, c.privileges]), [
    ["revoke", "alice", ["CONNECT", "CREATE"]],
    ["grant", "bob", ["CONNECT"]],
    ["grant", "alice", ["TEMPORARY"]],
  ]);
  assert.deepEqual(changes[1].target, { kind: "database", name: "shop" });
  assert.equal(changes[1].grantees[0].host, "%");
  assert.equal(changes[0].grant_option, false);
});

test("buildChanges is empty without edits and skips unreadable principals", () => {
  const a = user("alice");
  const base = new Map([[principalKey(a), null]]);
  assert.deepEqual(buildChanges([a], base, new Set(), "shop", COLUMNS), []);
  assert.deepEqual(buildChanges([a], base, new Set([cellId(principalKey(a), "CONNECT")]), "shop", COLUMNS), []);
});

test("matchesPrincipal looks at name, host and kind", () => {
  assert.equal(matchesPrincipal(user("alice"), ""), true);
  assert.equal(matchesPrincipal(user("alice"), "ALI"), true);
  assert.equal(matchesPrincipal(user("alice", "10.%"), "10."), true);
  assert.equal(matchesPrincipal(user("alice"), "role"), false);
  assert.equal(matchesPrincipal({ ...user("r"), kind: "role" }, "role"), true);
});

test("rebaseEdits keeps only what the server does not have yet", () => {
  const before = new Map([["a@", new Set(["CONNECT"])]]);
  const edits = new Set([cellId("a@", "CONNECT"), cellId("a@", "CREATE")]);
  // The revoke of CONNECT went through, the grant of CREATE did not.
  const after = new Map([["a@", new Set()]]);
  assert.deepEqual([...rebaseEdits(edits, before, after)], [cellId("a@", "CREATE")]);
  // Both went through.
  assert.equal(rebaseEdits(edits, before, new Map([["a@", new Set(["CREATE"])]])).size, 0);
  // A principal that can no longer be read loses its edits.
  assert.equal(rebaseEdits(edits, before, new Map([["a@", null]])).size, 0);
});

test("ALL is a shortcut for the other privileges", () => {
  const cols = ["ALL", "CONNECT", "CREATE"];
  const base = new Map([["a@", new Set(["CONNECT"])]]);
  assert.equal(isChecked(base, new Set(), "a@", "ALL", cols), false);
  const on = toggleCell(base, new Set(), "a@", "ALL", cols);
  assert.equal(isChecked(base, on, "a@", "ALL", cols), true);
  assert.deepEqual([...on], [cellId("a@", "CREATE")]);
  const off = toggleCell(base, on, "a@", "ALL", cols);
  assert.deepEqual([...off], [cellId("a@", "CONNECT")]);
  const full = new Map([["a@", heldColumns([{ kind: "database", schema: "d", privilege: "ALL PRIVILEGES" }], "d", cols)]]);
  assert.equal(isChecked(full, new Set(), "a@", "CREATE", cols), true);
  assert.equal(isChecked(full, toggleCell(full, new Set(), "a@", "CREATE", cols), "a@", "ALL", cols), false);
});
