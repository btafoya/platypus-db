// Unit tests of the Databases view's pure helpers (src/admin/databasesModel.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alterSpec,
  createSpec,
  dropConfirmed,
  dropRefusal,
  emptyForm,
  formatSize,
  formOf,
  formProblem,
  matchesDatabase,
  sortDatabases,
} from "../src/admin/databasesModel.ts";

const ALL = { owner: true, encoding: true, collation: true, template: true, connection_limit: true, comment: true, rename: true, force_drop: true };
const NONE = { owner: false, encoding: false, collation: false, template: false, connection_limit: false, comment: false, rename: false, force_drop: false };
const db = (over = {}) => ({ name: "shop", owner: "app", encoding: "UTF8", collation: "en_US", connection_limit: -1, comment: "old", system: false, current: false, ...over });

test("sortDatabases puts the user's first, then by name", () => {
  const sorted = sortDatabases([db({ name: "postgres", system: true }), db({ name: "b" }), db({ name: "a" })]);
  assert.deepEqual(sorted.map((d) => d.name), ["a", "b", "postgres"]);
});

test("formatSize", () => {
  assert.equal(formatSize(null), "");
  assert.equal(formatSize(undefined), "");
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1023), "1023 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(8 * 1024 * 1024), "8 MB");
  assert.equal(formatSize(150 * 1024 * 1024), "150 MB");
  assert.equal(formatSize(3 * 1024 ** 3), "3 GB");
});

test("formProblem asks a name only when creating, and a whole limit", () => {
  assert.equal(formProblem(emptyForm(), false), "name");
  assert.equal(formProblem(emptyForm(), true), null);
  assert.equal(formProblem({ ...emptyForm(), name: "x", limit: "abc" }, false), "limit");
  assert.equal(formProblem({ ...emptyForm(), name: "x", limit: "-1" }, false), "limit");
  assert.equal(formProblem({ ...emptyForm(), name: "x", limit: "5" }, false), null);
});

test("createSpec keeps only what the server offers", () => {
  const form = { ...emptyForm(), name: " shop ", owner: "app", encoding: "UTF8", limit: "4", comment: "hi" };
  assert.deepEqual(createSpec(form, ALL), {
    name: "shop", owner: "app", encoding: "UTF8", collation: null, template: null, connection_limit: 4, comment: "hi", rename_to: null,
  });
  assert.deepEqual(createSpec(form, NONE), {
    name: "shop", owner: null, encoding: null, collation: null, template: null, connection_limit: null, comment: null, rename_to: null,
  });
});

test("alterSpec sends only the changed fields", () => {
  const existing = db();
  assert.deepEqual(alterSpec(existing, formOf(existing), ALL), { name: "shop" });
  const form = { ...formOf(existing), comment: "new", limit: "3" };
  assert.deepEqual(alterSpec(existing, form, ALL), { name: "shop", comment: "new", connection_limit: 3 });
});

test("alterSpec clears a limit and a comment, renames, and ignores what is not offered", () => {
  const existing = db({ connection_limit: 7 });
  const form = { ...formOf(existing), limit: "", comment: "", renameTo: "shop2", owner: "other" };
  assert.deepEqual(alterSpec(existing, form, ALL), { name: "shop", owner: "other", connection_limit: -1, comment: "", rename_to: "shop2" });
  assert.deepEqual(alterSpec(existing, form, NONE), { name: "shop" });
  // Renaming to the same name is no rename.
  assert.deepEqual(alterSpec(existing, { ...formOf(existing), renameTo: "shop" }, ALL), { name: "shop" });
});

test("alterSpec passes an encoding change on, so the server can refuse it", () => {
  const existing = db();
  const spec = alterSpec(existing, { ...formOf(existing), encoding: "LATIN1" }, ALL);
  assert.equal(spec.encoding, "LATIN1");
});

test("dropRefusal and dropConfirmed", () => {
  assert.equal(dropRefusal(db({ system: true })), "system");
  assert.equal(dropRefusal(db({ current: true })), "current");
  assert.equal(dropRefusal(db()), null);
  assert.equal(dropConfirmed("shop", "shop"), true);
  assert.equal(dropConfirmed("Shop", "shop"), false);
  assert.equal(dropConfirmed("shop ", "shop"), false);
  assert.equal(dropConfirmed("", ""), false);
});

test("matchesDatabase looks at name, owner and comment", () => {
  assert.equal(matchesDatabase(db(), ""), true);
  assert.equal(matchesDatabase(db(), "SHO"), true);
  assert.equal(matchesDatabase(db(), "app"), true);
  assert.equal(matchesDatabase(db(), "old"), true);
  assert.equal(matchesDatabase(db(), "zzz"), false);
});
