/** The dialogs of the Databases view: create or change a database, and drop one. Each shows
 *  the statements the change runs before it does, and runs them on the navigator's session. */
import { type ReactNode, useEffect, useState } from "react";
import { api, type DatabaseChange, type DatabaseInfo, type DatabaseOptions, type SavedConnection, toCommandError } from "../api";
import { msg, t } from "../i18n";
import { workbench } from "../workbench";
import {
  alterSpec,
  createSpec,
  type DatabaseForm,
  type DatabaseProblem,
  dropConfirmed,
  emptyForm,
  formOf,
  formProblem,
} from "./databasesModel";

/** What every dialog needs from the view that opens it. */
export interface DatabaseEnv {
  connection: SavedConnection;
  /** The navigator's session, which the statements run on. */
  sideSession: () => Promise<number | null>;
  options: DatabaseOptions;
  /** Called after the statements ran. */
  onDone: () => void;
  onClose: () => void;
}

/** How long typing pauses before the statements are written again. */
const TYPING_PAUSE_MS = 250;

const PROBLEMS: Record<DatabaseProblem, string> = {
  name: msg("Type a name."),
  limit: msg("The connection limit is a whole number."),
};

interface FrameProps {
  env: DatabaseEnv;
  title: string;
  description: string;
  /** The primary button. */
  confirm: string;
  /** The change destroys something: the primary button says so. */
  danger?: boolean;
  /** The change the form describes; `null` while it is incomplete. */
  change: DatabaseChange | null;
  /** Says why `change` is `null`, when the form can tell. */
  problem?: string | null;
  /** Something else keeps the primary button off (the name not typed yet). */
  blocked?: boolean;
  children: ReactNode;
}

/** The frame of the dialogs: the form, the statements it makes, and the button that runs
 *  them. */
function Frame({ env, title, description, confirm, danger, change, problem, blocked, children }: FrameProps) {
  const { connection } = env;
  const key = change ? JSON.stringify(change) : null;
  /** The statements written for the change with this key, or why they could not be. */
  const [preview, setPreview] = useState<{ key: string; statements: string[] | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!change || !key) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const sid = await env.sideSession();
        if (sid === null || !current) return;
        const statements = await api.databasePreview(sid, change);
        if (current) setPreview({ key, statements, error: null });
      } catch (e) {
        if (current) setPreview({ key, statements: null, error: toCommandError(e).message });
      }
    }, TYPING_PAUSE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key]);

  // Only the statements of what the form holds now run: those of an earlier keystroke do not.
  const fresh = preview && preview.key === key ? preview : null;
  const statements = fresh?.statements ?? null;
  const runnable = !!change && !!statements && !running && !blocked && !connection.read_only;

  async function run() {
    if (!change || !runnable) return;
    setRunning(true);
    setError(null);
    try {
      const sid = await env.sideSession();
      if (sid === null) return;
      await api.applyDatabase(sid, change);
      env.onDone();
      env.onClose();
    } catch (e) {
      setError(toCommandError(e).message);
    } finally {
      setRunning(false);
    }
  }

  const script = statements ? `${statements.join(";\n")};` : null;
  const shown = script ?? (problem ? t(problem) : "…");
  return (
    <div className="modal-backdrop" onMouseDown={env.onClose}>
      <form
        className="modal sql-action security-dialog"
        data-dialog="database"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && env.onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <h2>{title}</h2>
        <p className="muted small">{description}</p>
        {children}
        <pre className="sql-preview" data-field="preview">
          {shown}
        </pre>
        {fresh?.error && (
          <div className="notice error small" data-field="preview-error">
            {fresh.error}
          </div>
        )}
        {connection.read_only && (
          <div className="notice warn small">{t("{name} is read-only: this statement cannot be run.", { name: connection.name })}</div>
        )}
        {error && (
          <div className="notice error small" data-field="run-error">
            {error}
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            className="link"
            disabled={!script}
            onClick={() => {
              if (!script) return;
              workbench().openTab("query", connection.id, { sql: script });
              env.onClose();
            }}
          >
            {t("Open in editor")}
          </button>
          <span className="spacer" />
          <button type="button" onClick={env.onClose}>
            {t("Cancel")}
          </button>
          <button type="submit" className={danger ? "primary danger" : "primary"} disabled={!runnable} data-action="run">
            {running ? t("Running…") : confirm}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A text field of a form. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** The form of a database, to create or, with `existing`, to change. Only the fields the
 *  server takes are shown; what it cannot change on an existing database is left to its
 *  refusal, which the preview shows. */
export function DatabaseDialog({ env, existing }: { env: DatabaseEnv; existing?: DatabaseInfo }) {
  const { options } = env;
  const [form, setForm] = useState<DatabaseForm>(() => (existing ? formOf(existing) : emptyForm()));
  const set = (patch: Partial<DatabaseForm>) => setForm((f) => ({ ...f, ...patch }));
  const editing = !!existing;
  const problem = formProblem(form, editing);
  const change: DatabaseChange | null = problem
    ? null
    : existing
      ? { change: "alter", spec: alterSpec(existing, form, options) }
      : { change: "create", spec: createSpec(form, options) };
  return (
    <Frame
      env={env}
      title={existing ? t("Edit {name}", { name: existing.name }) : t("New database")}
      description={
        editing
          ? t("Changes the attributes of the database; only what differs is written.")
          : t("Creates the database on the server.")
      }
      confirm={editing ? t("Save") : t("Create")}
      change={change}
      problem={problem ? PROBLEMS[problem] : null}
    >
      <Field label={t("Name")}>
        <input autoFocus={!editing} value={form.name} data-field="name" disabled={editing} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      {editing && options.rename && (
        <Field label={t("Rename to")}>
          <input value={form.renameTo} placeholder={t("Keep the name")} data-field="rename-to" onChange={(e) => set({ renameTo: e.target.value })} />
        </Field>
      )}
      <div className="row">
        {options.owner && (
          <Field label={t("Owner")}>
            <input value={form.owner} data-field="owner" onChange={(e) => set({ owner: e.target.value })} />
          </Field>
        )}
        {!editing && options.template && (
          <Field label={t("Template")}>
            <input value={form.template} data-field="template" onChange={(e) => set({ template: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="row">
        {options.encoding && (
          <Field label={t("Encoding")}>
            <input value={form.encoding} data-field="encoding" onChange={(e) => set({ encoding: e.target.value })} />
          </Field>
        )}
        {options.collation && (
          <Field label={t("Collation")}>
            <input value={form.collation} data-field="collation" onChange={(e) => set({ collation: e.target.value })} />
          </Field>
        )}
      </div>
      {options.connection_limit && (
        <Field label={t("Connection limit")}>
          <input value={form.limit} placeholder={t("No limit")} data-field="limit" onChange={(e) => set({ limit: e.target.value })} />
        </Field>
      )}
      {options.comment && (
        <Field label={t("Comment")}>
          <input value={form.comment} data-field="comment" onChange={(e) => set({ comment: e.target.value })} />
        </Field>
      )}
    </Frame>
  );
}

/** Drops a database, after its name is typed. */
export function DropDatabaseDialog({ env, database }: { env: DatabaseEnv; database: DatabaseInfo }) {
  const [typed, setTyped] = useState("");
  const [force, setForce] = useState(false);
  const change: DatabaseChange = { change: "drop", name: database.name, force: env.options.force_drop && force };
  return (
    <Frame
      env={env}
      title={t("Drop {name}", { name: database.name })}
      description={t("Removes the database with everything in it. It cannot be undone.")}
      confirm={t("Drop")}
      danger
      change={change}
      blocked={!dropConfirmed(typed, database.name)}
    >
      {env.options.force_drop && (
        <label className="check">
          <input type="checkbox" checked={force} data-field="force" onChange={(e) => setForce(e.target.checked)} />
          <span>{t("End the sessions connected to it first")}</span>
        </label>
      )}
      <Field label={t("Type {name} to confirm", { name: database.name })}>
        <input autoFocus value={typed} data-field="confirm" autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </Field>
    </Frame>
  );
}
