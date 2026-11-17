//! The databases of a server and the changes the app makes to them: what each one is
//! ([`DatabaseInfo`], from [`Connection::database_details`]) and how one is created, altered
//! or dropped ([`DatabaseChange`], turned into SQL by `platypus_sql::databases`).
//!
//! [`Connection::database_details`]: crate::Connection::database_details

use serde::{Deserialize, Serialize};

/// One database of the server, as the manager lists it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
    /// Who owns it, where the server tells.
    #[serde(default)]
    pub owner: Option<String>,
    /// Character set or encoding.
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    /// Size on disk, in bytes, where the session may read it.
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// Sessions connected to it now, where the server tells.
    #[serde(default)]
    pub connections: Option<u64>,
    /// Its limit of sessions at once, where it has one.
    #[serde(default)]
    pub connection_limit: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
    /// A database the server itself needs (`postgres`, `mysql`, `master`, ...): the manager
    /// shows it but refuses to drop it.
    #[serde(default)]
    pub system: bool,
    /// The one the session is connected to: it cannot be dropped from itself.
    #[serde(default)]
    pub current: bool,
}

/// A database to create or alter, as the form fills it. `None` leaves an attribute (when
/// altering) or takes the server's default (when creating).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseSpec {
    pub name: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    /// PostgreSQL: the database to copy. Creating only.
    #[serde(default)]
    pub template: Option<String>,
    /// Sessions allowed at once; `-1` removes the limit.
    #[serde(default)]
    pub connection_limit: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
    /// The new name, when renaming. Altering only.
    #[serde(default)]
    pub rename_to: Option<String>,
}

/// A change to the databases of a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "change", rename_all = "snake_case")]
pub enum DatabaseChange {
    Create {
        spec: DatabaseSpec,
    },
    Alter {
        spec: DatabaseSpec,
    },
    Drop {
        name: String,
        /// Ends the sessions connected to it first, where the server can
        /// (PostgreSQL `WITH (FORCE)`, SQL Server `SINGLE_USER`).
        #[serde(default)]
        force: bool,
    },
}
