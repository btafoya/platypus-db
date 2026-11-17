//! The databases of the server, for the admin tab: what they are, and the statements that
//! create, alter and drop them. The statements are written in `platypus_sql::databases`; the
//! preview shows them and `apply_database` runs them.

use futures::TryStreamExt;
use platypus_core::{DatabaseChange, DatabaseInfo, ExecOptions, ExecResult};
use platypus_sql::{
    Dialect,
    databases::{self, Attributes},
};
use tauri::State;

use super::{AppState, one_off};
use crate::error::{CommandError, CommandResult};

/// The databases of the server with their attributes.
#[tauri::command]
pub async fn list_database_details(
    state: State<'_, AppState>,
    session_id: u64,
) -> CommandResult<Vec<DatabaseInfo>> {
    let conn = state.live(session_id).await?;
    Ok(conn.database_details().await?)
}

/// The attributes the form of a database offers.
#[tauri::command]
pub async fn database_options(
    state: State<'_, AppState>,
    session_id: u64,
) -> CommandResult<Attributes> {
    let dialect = Dialect::from(state.session(session_id)?.config.driver);
    let conn = state.live(session_id).await?;
    let mut attributes = databases::attributes(dialect);
    attributes.force_drop &= databases::force_drop_supported(dialect, conn.server_info());
    Ok(attributes)
}

/// The statements `change` runs.
#[tauri::command]
pub async fn database_preview(
    state: State<'_, AppState>,
    session_id: u64,
    change: DatabaseChange,
) -> CommandResult<Vec<String>> {
    statements(&state, session_id, &change).await
}

/// Runs `change` on the session, a statement at a time, and returns the statements. Not on
/// a read-only connection. A change that fails half way is followed by the statements that
/// put the database back as it was ([`databases::recovery`]).
#[tauri::command]
pub async fn apply_database(
    state: State<'_, AppState>,
    session_id: u64,
    change: DatabaseChange,
) -> CommandResult<Vec<String>> {
    state.writable(session_id)?;
    let shown = statements(&state, session_id, &change).await?;
    let dialect = Dialect::from(state.session(session_id)?.config.driver);
    let conn = state.live(session_id).await?;
    let run = |sql: String| {
        let conn = &conn;
        async move {
            match conn.execute(&sql, &ExecOptions::default()).await? {
                ExecResult::Affected { .. } => {}
                ExecResult::Rows(stream) => stream.try_for_each(|_| async { Ok(()) }).await?,
            }
            Ok(())
        }
    };
    let done = one_off(&conn, async {
        for sql in &shown {
            run(sql.clone()).await?;
        }
        Ok(())
    })
    .await;
    if let Err(e) = done {
        for sql in databases::recovery(dialect, &change) {
            let _ = one_off(&conn, run(sql)).await;
        }
        return Err(e);
    }
    Ok(shown)
}

/// The statements for `change`, refusing to drop the database the session is in (the one the
/// server says, or else the one the connection names) or to force a drop the server cannot.
async fn statements(
    state: &State<'_, AppState>,
    session_id: u64,
    change: &DatabaseChange,
) -> CommandResult<Vec<String>> {
    let dialect = Dialect::from(state.session(session_id)?.config.driver);
    let mut current = state.session(session_id)?.config.database.clone();
    if matches!(change, DatabaseChange::Drop { .. }) {
        let conn = state.live(session_id).await?;
        if let Ok(all) = conn.database_details().await
            && let Some(db) = all.into_iter().find(|d| d.current)
        {
            current = db.name;
        }
        if let DatabaseChange::Drop { force: true, .. } = change
            && !databases::force_drop_supported(dialect, conn.server_info())
        {
            return Err(CommandError::new(
                "invalid_database_change",
                "this server cannot end the sessions connected to a database as it drops it",
            ));
        }
    }
    databases::statements(
        dialect,
        change,
        Some(current.as_str()).filter(|d| !d.is_empty()),
    )
    .map_err(|e| CommandError::new("invalid_database_change", e))
}
