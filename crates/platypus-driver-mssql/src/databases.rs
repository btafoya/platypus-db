//! The databases of the server, from `sys.databases` and `sys.master_files`. A login sees
//! the files of the databases it can access: the size of the others is unknown, not zero.

use platypus_core::{Connection, DatabaseInfo, Result, TextRowExt, query_text};

/// Name, owner, collation, size in bytes (8 KiB pages in `sys.master_files`), is current.
const DATABASES: &str = "SELECT d.name, SUSER_SNAME(d.owner_sid), d.collation_name, \
     (SELECT SUM(CAST(f.size AS bigint)) * 8192 FROM sys.master_files f \
      WHERE f.database_id = d.database_id), \
     CASE WHEN d.name = DB_NAME() THEN 1 ELSE 0 END \
     FROM sys.databases d ORDER BY d.name";

const SYSTEM: [&str; 4] = ["master", "tempdb", "model", "msdb"];

pub(crate) async fn database_details(conn: &dyn Connection) -> Result<Vec<DatabaseInfo>> {
    let mut list: Vec<DatabaseInfo> = query_text(conn, DATABASES)
        .await?
        .into_iter()
        .map(|r| {
            let name = r.text(0);
            DatabaseInfo {
                system: SYSTEM.contains(&name.to_lowercase().as_str()),
                owner: r.opt(1),
                collation: r.opt(2),
                size_bytes: r.number(3),
                current: r.flag(4),
                name,
                ..DatabaseInfo::default()
            }
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}
