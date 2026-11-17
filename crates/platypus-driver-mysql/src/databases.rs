//! The databases (schemas) of the server, from `information_schema`: character set,
//! collation and the size of their tables. A session sees only the schemas it has a
//! privilege on, and only their tables: the rest is absent, not an error.

use platypus_core::{Connection, DatabaseInfo, Result, TextRowExt, query_text};

const DATABASES: &str = "SELECT s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, \
     s.DEFAULT_COLLATION_NAME, \
     (SELECT CAST(SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)) AS UNSIGNED) \
      FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) \
     FROM information_schema.SCHEMATA s ORDER BY s.SCHEMA_NAME";

const SYSTEM: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

pub(crate) async fn database_details(conn: &dyn Connection) -> Result<Vec<DatabaseInfo>> {
    let current = query_text(conn, "SELECT DATABASE()")
        .await?
        .first()
        .and_then(|r| r.opt(0));
    let mut list: Vec<DatabaseInfo> = query_text(conn, DATABASES)
        .await?
        .into_iter()
        .map(|r| {
            let name = r.text(0);
            DatabaseInfo {
                system: SYSTEM.contains(&name.to_lowercase().as_str()),
                current: current.as_deref() == Some(name.as_str()),
                encoding: r.opt(1),
                collation: r.opt(2),
                size_bytes: r.number(3),
                name,
                ..DatabaseInfo::default()
            }
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}
