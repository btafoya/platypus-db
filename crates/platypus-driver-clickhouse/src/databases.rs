//! The databases of the server, from `system.databases`, and the size of their active parts
//! from `system.parts`. Older servers have no `comment` column and a user may not read
//! `system.parts`: the query then falls back to the names alone.

use platypus_core::{DatabaseInfo, Result, TextRowExt, query_text};

use crate::ClickHouseConnection;

/// Name, comment, bytes on disk, is current.
const DATABASES: &str = "SELECT d.name, d.comment, p.bytes, d.name = currentDatabase() \
     FROM system.databases d \
     LEFT JOIN (SELECT database, sum(bytes_on_disk) AS bytes FROM system.parts \
                WHERE active GROUP BY database) p ON p.database = d.name \
     ORDER BY d.name";

/// What any session can read: name, nothing, nothing, is current.
const NAMES: &str = "SELECT name, NULL, NULL, name = currentDatabase() FROM system.databases \
     ORDER BY name";

const SYSTEM: [&str; 3] = ["system", "information_schema", "INFORMATION_SCHEMA"];

pub(crate) async fn database_details(conn: &ClickHouseConnection) -> Result<Vec<DatabaseInfo>> {
    let rows = match query_text(conn, DATABASES).await {
        Ok(rows) => rows,
        Err(_) => query_text(conn, NAMES).await?,
    };
    Ok(rows
        .into_iter()
        .map(|r| {
            let name = r.text(0);
            DatabaseInfo {
                system: SYSTEM.contains(&name.as_str()),
                comment: r.opt(1).filter(|c| !c.is_empty()),
                size_bytes: r.number(2),
                current: r.flag(3),
                name,
                ..DatabaseInfo::default()
            }
        })
        .collect())
}
