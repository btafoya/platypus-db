// Pure helpers of the admin tab's Databases view: the list's order and size, and the changes
// the forms build. Types only from the app: the unit tests load this module without it.
import type { DatabaseInfo, DatabaseOptions, DatabaseSpec } from "../api";

/** The databases to show: those of the user first, the server's own after, each by name. */
export function sortDatabases(list: DatabaseInfo[]): DatabaseInfo[] {
  return [...list].sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** A size in bytes as people read it (`1.5 MB`); empty where the server did not tell. */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** What the form of a database holds, every field as typed. */
export interface DatabaseForm {
  name: string;
  owner: string;
  encoding: string;
  collation: string;
  template: string;
  /** Empty for no limit. */
  limit: string;
  comment: string;
  renameTo: string;
}

export type DatabaseProblem = "name" | "limit";

/** The form of an existing database, to start an alteration from. */
export function formOf(info: DatabaseInfo): DatabaseForm {
  const limit = info.connection_limit;
  return {
    name: info.name,
    owner: info.owner ?? "",
    encoding: info.encoding ?? "",
    collation: info.collation ?? "",
    template: "",
    limit: limit === null || limit === undefined || limit < 0 ? "" : String(limit),
    comment: info.comment ?? "",
    renameTo: "",
  };
}

/** An empty form, to create a database from. */
export const emptyForm = (): DatabaseForm => ({
  name: "",
  owner: "",
  encoding: "",
  collation: "",
  template: "",
  limit: "",
  comment: "",
  renameTo: "",
});

/** Why the form cannot be turned into a change yet, if it cannot. */
export function formProblem(form: DatabaseForm, editing: boolean): DatabaseProblem | null {
  if (!editing && !form.name.trim()) return "name";
  if (form.limit.trim() && !/^\d+$/.test(form.limit.trim())) return "limit";
  return null;
}

const orNull = (text: string) => text.trim() || null;

/** The spec of a database to create: what the server offers and the form filled. */
export function createSpec(form: DatabaseForm, offered: DatabaseOptions): DatabaseSpec {
  return {
    name: form.name.trim(),
    owner: offered.owner ? orNull(form.owner) : null,
    encoding: offered.encoding ? orNull(form.encoding) : null,
    collation: offered.collation ? orNull(form.collation) : null,
    template: offered.template ? orNull(form.template) : null,
    connection_limit: offered.connection_limit && form.limit.trim() ? Number(form.limit.trim()) : null,
    comment: offered.comment && form.comment.trim() ? form.comment : null,
    rename_to: null,
  };
}

/** The spec of an alteration: only what differs from `existing` is set. A cleared limit
 *  becomes `-1`, a cleared comment an empty one. */
export function alterSpec(existing: DatabaseInfo, form: DatabaseForm, offered: DatabaseOptions): DatabaseSpec {
  const before = formOf(existing);
  const changed = (key: keyof DatabaseForm) => form[key].trim() !== before[key].trim();
  const spec: DatabaseSpec = { name: existing.name };
  if (offered.owner && changed("owner") && form.owner.trim()) spec.owner = form.owner.trim();
  if (offered.encoding && changed("encoding") && form.encoding.trim()) spec.encoding = form.encoding.trim();
  if (offered.collation && changed("collation") && form.collation.trim()) spec.collation = form.collation.trim();
  if (offered.connection_limit && changed("limit")) spec.connection_limit = form.limit.trim() ? Number(form.limit.trim()) : -1;
  if (offered.comment && form.comment !== before.comment) spec.comment = form.comment;
  if (offered.rename && form.renameTo.trim() && form.renameTo.trim() !== existing.name) spec.rename_to = form.renameTo.trim();
  return spec;
}

/** Whether the manager lets `info` be dropped: not a server database, not the one in use. */
export const droppable = (info: DatabaseInfo) => !info.system && !info.current;

/** Why `info` cannot be dropped, or `null` when it can. */
export function dropRefusal(info: DatabaseInfo): "system" | "current" | null {
  if (info.system) return "system";
  if (info.current) return "current";
  return null;
}

/** Whether `typed` is the database's name, exactly: the dialog asks for it before it drops. */
export const dropConfirmed = (typed: string, name: string) => name !== "" && typed === name;

/** Whether `info` matches the filter text: its name, owner or comment. */
export function matchesDatabase(info: DatabaseInfo, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [info.name, info.owner ?? "", info.comment ?? ""].some((text) => text.toLowerCase().includes(needle));
}
