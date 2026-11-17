// Pure model of the permission matrix of a database: the grid of who holds which privilege,
// the cells the person changed, and the GRANT and REVOKE changes they make. Types only from
// the app: the unit tests load this module without it.
import type { Principal, PrivilegeGrant, SecurityChange } from "../api";

/** The column that stands for every privilege, where the server lists it. */
export const ALL_COLUMN = "ALL";

/** The id of a principal in the grid: its name, and the host of a MySQL account. */
export const principalKey = (p: Pick<Principal, "name" | "host">) => `${p.name}@${p.host ?? ""}`;

/** The id of a cell: a principal's and a privilege's. */
export const cellId = (key: string, privilege: string) => `${key}\u0000${privilege}`;

const upper = (text: string) => text.trim().toUpperCase();

/** A database name as the grants write it: MySQL escapes `_` and `%` in the names of a grant. */
const plainName = (name: string) => name.replace(/\\([_%])/g, "$1");

/** Whether `grant` is on the database `database`. SQL Server's grants name no database: they
 *  are those of the one the session is in, which is the one the matrix is opened on. */
export function onDatabase(grant: PrivilegeGrant, database: string, unnamed = false): boolean {
  if (grant.kind !== "database") return false;
  if (unnamed) return true;
  return [grant.schema, grant.object].some((n) => n !== null && n !== undefined && plainName(n) === database);
}

/** The columns that hold, among `columns`, for the principal whose grants are `grants`: a column
 *  holds where the principal was given the privilege itself; `ALL` where it was given `ALL`, or
 *  every other privilege of the list. */
export function heldColumns(grants: PrivilegeGrant[], database: string, columns: string[], unnamed = false): Set<string> {
  const given = new Set(grants.filter((g) => onDatabase(g, database, unnamed)).map((g) => upper(g.privilege)));
  const held = new Set<string>();
  const everything = given.has("ALL") || given.has("ALL PRIVILEGES");
  const others = columns.filter((c) => upper(c) !== ALL_COLUMN);
  for (const column of columns) {
    const name = upper(column);
    if (name === ALL_COLUMN) {
      if (everything || (others.length > 0 && others.every((c) => given.has(upper(c))))) held.add(column);
    } else if (everything || given.has(name)) {
      held.add(column);
    }
  }
  return held;
}

/** What the grid starts from: for each principal the columns it holds, `null` where its grants
 *  could not be read. */
export type Base = Map<string, Set<string> | null>;

/** Flips a cell: it joins the edits, or leaves them when it goes back to what it was. */
export function toggleEdit(edits: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(edits);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Whether the cell shows as checked: what the server has, flipped when edited. The `ALL` cell
 *  is checked when every other privilege of `columns` is: it is a shortcut for them, with no
 *  edit of its own. */
export function isChecked(base: Base, edits: ReadonlySet<string>, key: string, column: string, columns: string[] = []): boolean {
  const others = columns.filter((c) => upper(c) !== ALL_COLUMN);
  if (upper(column) === ALL_COLUMN && others.length > 0) {
    return others.every((c) => isChecked(base, edits, key, c));
  }
  const held = base.get(key)?.has(column) ?? false;
  return held !== edits.has(cellId(key, column));
}

/** The edits after a click on a cell. A click on `ALL` sets every other privilege to the
 *  opposite of what the cell shows. */
export function toggleCell(base: Base, edits: ReadonlySet<string>, key: string, column: string, columns: string[]): Set<string> {
  const others = columns.filter((c) => upper(c) !== ALL_COLUMN);
  if (upper(column) !== ALL_COLUMN || others.length === 0) return toggleEdit(edits, cellId(key, column));
  const target = !isChecked(base, edits, key, column, columns);
  const next = new Set(edits);
  for (const c of others) {
    const id = cellId(key, c);
    if (isChecked(base, next, key, c) !== target) {
      if (!next.delete(id)) next.add(id);
    }
  }
  return next;
}

/** The changes the edits make: one per principal and action, privileges grouped, the revokes
 *  first. Principals without readable grants are left out. */
export function buildChanges(principals: Principal[], base: Base, edits: ReadonlySet<string>, database: string, columns: string[]): SecurityChange[] {
  const grants: SecurityChange[] = [];
  const revokes: SecurityChange[] = [];
  for (const principal of principals) {
    const key = principalKey(principal);
    const held = base.get(key);
    if (!held) continue;
    for (const action of ["revoke", "grant"] as const) {
      const privileges = columns.filter((c) => edits.has(cellId(key, c)) && held.has(c) === (action === "revoke"));
      if (privileges.length === 0) continue;
      const change: SecurityChange = {
        change: "privileges",
        action,
        grantees: [{ name: principal.name, host: principal.host }],
        target: { kind: "database", name: database },
        privileges,
        grant_option: false,
        cascade: false,
      };
      (action === "revoke" ? revokes : grants).push(change);
    }
  }
  return [...revokes, ...grants];
}

/** Whether the principal matches the filter text: its name or kind. */
export function matchesPrincipal(p: Principal, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [p.name, p.host ?? "", p.kind].some((text) => text.toLowerCase().includes(needle));
}

/** The edits after the grants were read again: the cells that still differ from the server's
 *  new answer, so what was applied is no longer marked and what was not stays. */
export function rebaseEdits(edits: ReadonlySet<string>, before: Base, after: Base): Set<string> {
  const kept = new Set<string>();
  for (const id of edits) {
    const [key = "", column = ""] = id.split("\u0000");
    const wanted = !(before.get(key)?.has(column) ?? false);
    const held = after.get(key);
    if (held && held.has(column) !== wanted) kept.add(id);
  }
  return kept;
}
