/** The permission matrix of a database: the users and roles of the server against the
 *  privileges on a database. A cell flips what the principal was given itself; the statements
 *  the flips make are shown before they run. */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Principal, type SavedConnection, toCommandError } from "../api";
import { plural, t } from "../i18n";
import {
  type Base,
  buildChanges,
  cellId,
  heldColumns,
  isChecked,
  matchesPrincipal,
  principalKey,
  rebaseEdits,
  toggleCell,
} from "./permissionMatrixModel";

interface Props {
  connection: SavedConnection;
  /** The navigator's session, which the statements run on. */
  sideSession: () => Promise<number | null>;
  /** The database the matrix is on. */
  database: string;
  onClose: () => void;
}

/** How many principals' grants are read at once. */
const READ_AT_ONCE = 6;
/** How long a change waits before its statements are written again. */
const PAUSE_MS = 250;

/** What is known of the server: who is in the grid and what can be granted. */
interface Loaded {
  principals: Principal[];
  columns: string[];
}

/** The grants of every principal, read in parallel; `done` counts those read. */
interface Grants {
  base: Base;
  errors: Map<string, string>;
  done: number;
  total: number;
}

const NO_COLUMNS: string[] = [];
const NO_PRINCIPALS: Principal[] = [];
const EMPTY_GRANTS: Grants = { base: new Map(), errors: new Map(), done: 0, total: 0 };

export function PermissionMatrixDialog({ connection, sideSession, database, onClose }: Props) {
  // SQL Server's grants name no database: they are those of the one the session is in.
  const unnamed = connection.driver === "sqlserver";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grants>(EMPTY_GRANTS);
  const [reads, setReads] = useState(0);
  const [edits, setEdits] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<{ key: string; statements: string[]; error: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  /** The grants and edits as they were when the last read started, to tell what it changed. */
  const snapshot = useRef<{ base: Base; edits: Set<string> } | null>(null);

  // The principals and the privileges, then the grants of each, a few at a time.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const sid = await sideSession();
        if (sid === null || !current) return;
        const [principals, options] = await Promise.all([api.listPrincipals(sid), api.securityOptions(sid)]);
        if (!current) return;
        const columns = [...new Set(options.targets.find((x) => x.target === "database")?.privileges ?? [])];
        setLoaded({ principals, columns });
        const base: Base = new Map();
        const errors = new Map<string, string>();
        let done = 0;
        let next = 0;
        setGrants({ base, errors, done, total: principals.length });
        const worker = async () => {
          for (let p = principals[next++]; current && p; p = principals[next++]) {
            const key = principalKey(p);
            try {
              base.set(key, heldColumns(await api.principalPrivileges(sid, p.name, p.host), database, columns, unnamed));
            } catch (e) {
              base.set(key, null);
              errors.set(key, toCommandError(e).message);
            }
            done += 1;
            if (current) setGrants({ base: new Map(base), errors: new Map(errors), done, total: principals.length });
          }
        };
        if (columns.length > 0) await Promise.all(Array.from({ length: READ_AT_ONCE }, worker));
        if (!current) return;
        const before = snapshot.current;
        if (before) setEdits(rebaseEdits(before.edits, before.base, base));
        setLoadError(null);
      } catch (e) {
        if (current) setLoadError(toCommandError(e).message);
      }
    })();
    return () => {
      current = false;
    };
  }, [reads]);

  const columns = loaded?.columns ?? NO_COLUMNS;
  const principals = loaded?.principals ?? NO_PRINCIPALS;
  const shown = principals.filter((p) => matchesPrincipal(p, filter));
  const reading = !!loaded && grants.done < grants.total && columns.length > 0;
  const changes = useMemo(
    () => (reading ? [] : buildChanges(principals, grants.base, edits, database, columns)),
    [reading, principals, grants.base, edits, database, columns],
  );
  const key = JSON.stringify(changes);

  // The statements of every change, one change at a time; the first the server refuses is shown.
  useEffect(() => {
    if (changes.length === 0) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      const statements: string[] = [];
      try {
        const sid = await sideSession();
        if (sid === null || !current) return;
        for (const change of changes) statements.push(...(await api.securityPreview(sid, change)));
        if (current) setPreview({ key, statements, error: null });
      } catch (e) {
        if (current) setPreview({ key, statements, error: toCommandError(e).message });
      }
    }, PAUSE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key]);

  const fresh = preview && preview.key === key && changes.length > 0 ? preview : null;
  const runnable = !!fresh && !fresh.error && !running && !connection.read_only;
  const text = changes.length === 0 ? t("No changes.") : fresh && fresh.statements.length > 0 ? `${fresh.statements.join(";\n")};` : "…";

  const flip = (principal: Principal, column: string) => {
    setApplied(null);
    setEdits((old) => toggleCell(grants.base, old, principalKey(principal), column, columns));
  };

  async function run() {
    if (!runnable) return;
    setRunning(true);
    setRunError(null);
    setApplied(null);
    let ran = 0;
    try {
      const sid = await sideSession();
      if (sid === null) return;
      for (const change of changes) {
        await api.applySecurity(sid, change);
        ran += 1;
      }
      setApplied(ran);
    } catch (e) {
      setRunError(toCommandError(e).message);
    } finally {
      // What ran is read back, whether or not the rest did.
      snapshot.current = { base: grants.base, edits };
      setRunning(false);
      setReads((n) => n + 1);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal sql-action security-dialog permission-matrix"
        data-dialog="permissions"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <h2>{t("Permissions on {name}", { name: database })}</h2>
        <p className="muted small">
          {t("Tick the privileges a user or role is given on the database. Only what each was given itself is changed, not what it has through its roles.")}
        </p>
        {loadError && (
          <div className="notice error small" data-field="load-error">
            {loadError}
          </div>
        )}
        {loaded && columns.length === 0 ? (
          <div className="notice small" data-field="no-privileges">
            {t("This server has no database-level privileges.")}
          </div>
        ) : (
          <>
            <div className="admin-toolbar">
              <input type="search" data-field="filter" placeholder={t("Filter users and roles")} value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="spacer" />
              {reading && (
                <span className="muted small" data-field="progress">
                  {t("Reading the privileges… {done} of {total}", { done: grants.done, total: grants.total })}
                </span>
              )}
              <button type="button" data-action="reset" disabled={edits.size === 0 || running} onClick={() => setEdits(new Set())}>
                {t("Reset")}
              </button>
            </div>
            <div className="permission-grid">
              <table className="meta-table admin-table" data-field="matrix">
                <thead>
                  <tr>
                    <th>{t("User or role")}</th>
                    {columns.map((c) => (
                      <th key={c} className="permission-cell">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const id = principalKey(p);
                    const failed = grants.errors.get(id);
                    const waiting = !grants.base.has(id);
                    return (
                      <tr key={id} data-name={p.name} data-host={p.host ?? ""}>
                        <td>
                          {p.name}
                          {p.host ? `@${p.host}` : ""}
                          <span className="admin-badge">{p.kind === "user" ? t("user") : t("role")}</span>
                        </td>
                        {failed ? (
                          <td colSpan={columns.length} className="permission-error" data-field="grants-error" title={failed}>
                            {t("Could not read: {error}", { error: failed })}
                          </td>
                        ) : (
                          columns.map((c) => {
                            const dirty = edits.has(cellId(id, c));
                            return (
                              <td key={c} className={`permission-cell${dirty ? " dirty" : ""}`} data-dirty={dirty}>
                                <input
                                  type="checkbox"
                                  data-principal={p.name}
                                  data-privilege={c}
                                  disabled={waiting || running || connection.read_only}
                                  checked={isChecked(grants.base, edits, id, c, columns)}
                                  aria-label={`${p.name} ${c}`}
                                  onChange={() => flip(p, c)}
                                />
                              </td>
                            );
                          })
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {loaded && shown.length === 0 && <p className="muted small">{t("No users or roles match.")}</p>}
            </div>
            <pre className="sql-preview" data-field="preview">
              {text}
            </pre>
            {fresh?.error && (
              <div className="notice error small" data-field="preview-error">
                {fresh.error}
              </div>
            )}
          </>
        )}
        {runError && (
          <div className="notice error small" data-field="run-error">
            {runError}
          </div>
        )}
        {applied !== null && (
          <div className="notice small" data-field="applied">
            {plural(applied, "Applied {n} change.", "Applied {n} changes.")}
          </div>
        )}
        <div className="actions">
          <span className="spacer" />
          <button type="button" data-action="close" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="submit" className="primary" disabled={!runnable} data-action="run">
            {running ? t("Running…") : t("Apply")}
          </button>
        </div>
      </form>
    </div>
  );
}
