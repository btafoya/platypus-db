/** The admin tab's Databases view: the databases of the server with their owner, encoding,
 *  size and connections, and the dialogs that create, change and drop them. */
import { useEffect, useState } from "react";
import { api, type DatabaseInfo, type DatabaseOptions, type SavedConnection, toCommandError } from "../api";
import { t } from "../i18n";
import { EmptyState, LoadingState } from "../ui/State";
import { DatabaseDialog, type DatabaseEnv, DropDatabaseDialog } from "./DatabaseDialogs";
import { PermissionMatrixDialog } from "./PermissionMatrixDialog";
import { dropRefusal, formatSize, matchesDatabase, sortDatabases } from "./databasesModel";

/** The dialog that is open. */
type Dialog = { kind: "permissions"; database: DatabaseInfo } | { kind: "new" } | { kind: "edit"; database: DatabaseInfo } | { kind: "drop"; database: DatabaseInfo };

interface Props {
  connection: SavedConnection;
  active: boolean;
  /** Counts the refreshes asked from outside: the tab's button. */
  refresh: number;
  /** Whether the server has users and privileges to manage (`caps.security`). */
  security: boolean;
  sideSession: () => Promise<number | null>;
}

export function Databases({ connection, active, refresh, security, sideSession }: Props) {
  const [databases, setDatabases] = useState<DatabaseInfo[] | null>(null);
  const [options, setOptions] = useState<DatabaseOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** Counts the reads of the list this view asked for itself, after a change. */
  const [reads, setReads] = useState(0);
  const chosen = databases?.find((d) => d.name === selected) ?? null;

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    void (async () => {
      try {
        const sid = await sideSession();
        if (sid === null || !current) return;
        const [list, offered] = await Promise.all([api.listDatabaseDetails(sid), options ?? api.databaseOptions(sid)]);
        if (!current) return;
        setDatabases(sortDatabases(list));
        setOptions(offered);
        setError(null);
      } catch (e) {
        if (current) setError(toCommandError(e).message);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [active, refresh, reads]);

  const shown = (databases ?? []).filter((d) => matchesDatabase(d, filter));
  const readOnly = connection.read_only ? t("The connection is read-only") : undefined;
  const refusal = chosen ? dropRefusal(chosen) : null;
  const dropWhy = readOnly ?? (refusal === "system" ? t("A database of the server cannot be dropped") : refusal === "current" ? t("The connection is using this database") : undefined);

  // SQL Server's grants name no database: the matrix is of the one the session is in.
  const permissionsWhy =
    readOnly ?? (connection.driver === "sqlserver" && chosen && !chosen.current ? t("Only the database the connection is in can be managed here") : undefined);

  const env: DatabaseEnv | null = options
    ? { connection, sideSession, options, onDone: () => setReads((n) => n + 1), onClose: () => setDialog(null) }
    : null;

  return (
    <div className="object-body admin-body admin-databases" data-view="databases">
      <div className="admin-toolbar">
        <button disabled={!options || !!readOnly} title={readOnly} data-action="new" onClick={() => setDialog({ kind: "new" })}>
          {t("New database…")}
        </button>
        <button disabled={!chosen || !!readOnly} title={readOnly} data-action="edit" onClick={() => chosen && setDialog({ kind: "edit", database: chosen })}>
          {t("Edit…")}
        </button>
        <button disabled={!chosen || !!dropWhy} title={dropWhy} data-action="drop" onClick={() => chosen && setDialog({ kind: "drop", database: chosen })}>
          {t("Drop…")}
        </button>
        {security && (
          <button
            disabled={!chosen || !!permissionsWhy}
            title={permissionsWhy}
            data-action="permissions"
            onClick={() => chosen && setDialog({ kind: "permissions", database: chosen })}
          >
            {t("Permissions…")}
          </button>
        )}
        <button disabled={loading} data-action="refresh" onClick={() => setReads((n) => n + 1)}>
          {t("Refresh")}
        </button>
        <span className="spacer" />
        <input type="search" placeholder={t("Filter by name, owner or comment")} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error && (
        <div className="notice error small" data-field="databases-error">
          {error}
        </div>
      )}
      <div className="admin-list">
        <table className="meta-table admin-table admin-databases-table">
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Owner")}</th>
              <th>{t("Encoding")}</th>
              <th>{t("Collation")}</th>
              <th className="num">{t("Size")}</th>
              <th className="num">{t("Connections")}</th>
              <th>{t("Comment")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr
                key={d.name}
                data-name={d.name}
                data-system={d.system}
                data-current={d.current}
                className={`admin-session admin-database${d.name === selected ? " selected" : ""}${d.system ? " system" : ""}`}
                onClick={() => setSelected(d.name)}
              >
                <td>
                  {d.name}
                  {d.current && <span className="admin-badge database-current">{t("current")}</span>}
                </td>
                <td>{d.owner}</td>
                <td>{d.encoding}</td>
                <td>{d.collation}</td>
                <td className="num">{formatSize(d.size_bytes)}</td>
                <td className="num">{d.connections ?? ""}</td>
                <td className="admin-query">{d.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 &&
          (loading && !databases ? (
            <LoadingState compact className="admin-empty" title={t("Reading the databases…")} />
          ) : (
            <EmptyState compact className="admin-empty" title={t("No databases match.")} />
          ))}
      </div>
      {dialog?.kind === "permissions" && (
        <PermissionMatrixDialog connection={connection} sideSession={sideSession} database={dialog.database.name} onClose={() => setDialog(null)} />
      )}
      {env && dialog?.kind === "new" && <DatabaseDialog env={env} />}
      {env && dialog?.kind === "edit" && <DatabaseDialog env={env} existing={dialog.database} />}
      {env && dialog?.kind === "drop" && <DropDatabaseDialog env={env} database={dialog.database} />}
    </div>
  );
}
