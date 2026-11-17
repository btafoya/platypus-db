//! The databases of the server, from `pg_database`, with their owner, encoding, size and
//! sessions. The size is read only where the session may connect, the rest of the columns
//! are readable by everyone.

use platypus_core::{Connection, DatabaseInfo, Result, TextRowExt, query_text};

/// Name, owner, encoding, collation, size, sessions, session limit, comment, is current.
const DATABASES: &str = "SELECT d.datname, r.rolname, pg_encoding_to_char(d.encoding), \
     d.datcollate, \
     CASE WHEN d.datallowconn AND has_database_privilege(d.datname, 'CONNECT') \
          THEN pg_database_size(d.datname) END, \
     s.numbackends, NULLIF(d.datconnlimit, -1), \
     shobj_description(d.oid, 'pg_database'), d.datname = current_database() \
     FROM pg_database d \
     LEFT JOIN pg_roles r ON r.oid = d.datdba \
     LEFT JOIN pg_stat_database s ON s.datid = d.oid \
     ORDER BY d.datname";

const SYSTEM: [&str; 3] = ["template0", "template1", "postgres"];

pub(crate) async fn database_details(conn: &dyn Connection) -> Result<Vec<DatabaseInfo>> {
    Ok(query_text(conn, DATABASES)
        .await?
        .into_iter()
        .map(|r| {
            let name = r.text(0);
            DatabaseInfo {
                system: SYSTEM.contains(&name.as_str()),
                owner: r.opt(1),
                encoding: r.opt(2),
                collation: r.opt(3),
                size_bytes: r.number(4),
                connections: r.number(5),
                connection_limit: r.opt(6).and_then(|n| n.parse().ok()),
                comment: r.opt(7).filter(|c| !c.is_empty()),
                current: r.flag(8),
                name,
            }
        })
        .collect())
}
