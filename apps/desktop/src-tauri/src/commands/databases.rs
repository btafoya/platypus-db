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
pub fn database_options(state: State<'_, AppState>, session_id: u64) -> CommandResult<Attributes> {
    let dialect = Dialect::from(state.session(session_id)?.config.driver);
    Ok(databases::attributes(dialect))
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
/// a read-only connection.
#[tauri::command]
pub async fn apply_database(
    state: State<'_, AppState>,
    session_id: u64,
    change: DatabaseChange,
) -> CommandResult<Vec<String>> {
    state.writable(session_id)?;
    let shown = statements(&state, session_id, &change).await?;
    let conn = state.live(session_id).await?;
    one_off(&conn, async {
        for sql in &shown {
            match conn.execute(sql, &ExecOptions::default()).await? {
                ExecResult::Affected { .. } => {}
                ExecResult::Rows(stream) => stream.try_for_each(|_| async { Ok(()) }).await?,
            }
        }
        Ok(())
    })
    .await?;
    Ok(shown)
}

/// The statements for `change`, refusing to drop the database the session is in.
async fn statements(
    state: &State<'_, AppState>,
    session_id: u64,
    change: &DatabaseChange,
) -> CommandResult<Vec<String>> {
    let session = state.session(session_id)?;
    databases::statements(
        Dialect::from(session.config.driver),
        change,
        Some(session.config.database.as_str()).filter(|d| !d.is_empty()),
    )
    .map_err(|e| CommandError::new("invalid_database_change", e))
}
