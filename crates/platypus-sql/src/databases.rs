//! The statements that create, alter and drop databases, for PostgreSQL, MySQL and
//! `MariaDB`, SQL Server and `ClickHouse` ([`statements`]), and the attributes each of them
//! takes ([`attributes`]).
//!
//! The app shows the statements before they run and writes them to its query log.

use platypus_core::{DatabaseChange, DatabaseSpec};

use crate::Dialect;

/// Why a change cannot be written for this database: shown to the user as it is.
pub type Unsupported = String;

/// What a database of a kind takes in its form.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[allow(clippy::struct_excessive_bools)]
pub struct Attributes {
    pub owner: bool,
    pub encoding: bool,
    pub collation: bool,
    pub template: bool,
    pub connection_limit: bool,
    pub comment: bool,
    pub rename: bool,
    /// Dropping can end the sessions connected to the database first.
    pub force_drop: bool,
}

/// The attributes `dialect` can set, none for a database without databases to manage.
#[must_use]
pub fn attributes(dialect: Dialect) -> Attributes {
    match dialect {
        Dialect::Postgres => Attributes {
            owner: true,
            encoding: true,
            collation: true,
            template: true,
            connection_limit: true,
            comment: true,
            rename: true,
            force_drop: true,
        },
        Dialect::MySql => Attributes {
            encoding: true,
            collation: true,
            ..Attributes::default()
        },
        Dialect::SqlServer => Attributes {
            owner: true,
            collation: true,
            rename: true,
            force_drop: true,
            ..Attributes::default()
        },
        Dialect::ClickHouse => Attributes {
            comment: true,
            rename: true,
            ..Attributes::default()
        },
        _ => Attributes::default(),
    }
}

/// The statements that make `change`, in the order they run.
///
/// # Errors
/// When the name is empty, or the database has no such attribute.
pub fn statements(
    dialect: Dialect,
    change: &DatabaseChange,
    current: Option<&str>,
) -> Result<Vec<String>, Unsupported> {
    let allowed = attributes(dialect);
    if allowed == Attributes::default() {
        return Err("databases cannot be managed for this database".to_owned());
    }
    let w = Writer { dialect, allowed };
    match change {
        DatabaseChange::Create { spec } => w.create(spec),
        DatabaseChange::Alter { spec } => w.alter(spec),
        DatabaseChange::Drop { name, force } => w.drop(name, *force, current),
    }
}

struct Writer {
    dialect: Dialect,
    allowed: Attributes,
}

impl Writer {
    fn id(&self, name: &str) -> String {
        self.dialect.quote_ident_always(name)
    }

    fn lit(&self, value: &str) -> String {
        self.dialect.quote_literal(value)
    }

    /// Refuses a form field the database has no such attribute for.
    fn check(&self, spec: &DatabaseSpec, altering: bool) -> Result<(), Unsupported> {
        let a = self.allowed;
        let fields = [
            (spec.owner.is_some(), a.owner, "an owner"),
            (spec.encoding.is_some(), a.encoding, "an encoding"),
            (spec.collation.is_some(), a.collation, "a collation"),
            (spec.template.is_some(), a.template, "a template"),
            (
                spec.connection_limit.is_some(),
                a.connection_limit,
                "a connection limit",
            ),
            (spec.comment.is_some(), a.comment, "a comment"),
            (spec.rename_to.is_some(), a.rename, "a new name"),
        ];
        for (set, ok, what) in fields {
            if set && !ok {
                return Err(format!("this database does not take {what}"));
            }
        }
        if altering && self.dialect == Dialect::Postgres && spec.template.is_some() {
            return Err("a template only applies when a database is created".to_owned());
        }
        if altering
            && self.dialect == Dialect::Postgres
            && (spec.encoding.is_some() || spec.collation.is_some())
        {
            return Err("the encoding and collation of a database cannot be changed".to_owned());
        }
        if altering && self.dialect == Dialect::ClickHouse && spec.name.is_empty() {
            return Err(NAME.to_owned());
        }
        Ok(())
    }

    fn create(&self, spec: &DatabaseSpec) -> Result<Vec<String>, Unsupported> {
        let name = named(&spec.name)?;
        self.check(spec, false)?;
        if spec.rename_to.is_some() {
            return Err("a new name only applies when a database is altered".to_owned());
        }
        let mut sql = format!("CREATE DATABASE {}", self.id(name));
        let mut out = Vec::new();
        match self.dialect {
            Dialect::Postgres => {
                self.opt(&mut sql, "OWNER", spec.owner.as_deref(), true);
                self.opt(&mut sql, "TEMPLATE", spec.template.as_deref(), true);
                self.opt(&mut sql, "ENCODING", spec.encoding.as_deref(), false);
                if let Some(c) = spec.collation.as_deref().filter(|c| !c.is_empty()) {
                    let lit = self.lit(c);
                    sql.push_str(&format!(" LC_COLLATE {lit} LC_CTYPE {lit}"));
                }
                if let Some(n) = spec.connection_limit {
                    sql.push_str(&format!(" CONNECTION LIMIT {n}"));
                }
                out.push(sql);
                self.comment(&mut out, name, spec.comment.as_deref());
            }
            Dialect::MySql => {
                self.opt(&mut sql, "CHARACTER SET", spec.encoding.as_deref(), false);
                self.opt(&mut sql, "COLLATE", spec.collation.as_deref(), false);
                out.push(sql);
            }
            Dialect::SqlServer => {
                self.opt(&mut sql, "COLLATE", spec.collation.as_deref(), false);
                out.push(sql);
                if let Some(o) = spec.owner.as_deref().filter(|o| !o.is_empty()) {
                    out.push(self.authorization(name, o));
                }
            }
            _ => {
                if let Some(c) = spec.comment.as_deref().filter(|c| !c.is_empty()) {
                    sql.push_str(&format!(" COMMENT {}", self.lit(c)));
                }
                out.push(sql);
            }
        }
        Ok(out)
    }

    fn alter(&self, spec: &DatabaseSpec) -> Result<Vec<String>, Unsupported> {
        let name = named(&spec.name)?;
        self.check(spec, true)?;
        let id = self.id(name);
        let mut out = Vec::new();
        match self.dialect {
            Dialect::Postgres => {
                if let Some(o) = spec.owner.as_deref().filter(|o| !o.is_empty()) {
                    out.push(format!("ALTER DATABASE {id} OWNER TO {}", self.id(o)));
                }
                if let Some(n) = spec.connection_limit {
                    out.push(format!("ALTER DATABASE {id} CONNECTION LIMIT {n}"));
                }
                self.comment(&mut out, name, spec.comment.as_deref());
                if let Some(to) = spec.rename_to.as_deref().filter(|t| *t != name) {
                    out.push(format!("ALTER DATABASE {id} RENAME TO {}", self.id(to)));
                }
            }
            Dialect::MySql => {
                let mut sql = format!("ALTER DATABASE {id}");
                self.opt(&mut sql, "CHARACTER SET", spec.encoding.as_deref(), false);
                self.opt(&mut sql, "COLLATE", spec.collation.as_deref(), false);
                if sql.len() > id.len() + "ALTER DATABASE ".len() {
                    out.push(sql);
                }
            }
            Dialect::SqlServer => {
                if let Some(c) = spec.collation.as_deref().filter(|c| !c.is_empty()) {
                    out.push(format!("ALTER DATABASE {id} COLLATE {c}"));
                }
                if let Some(o) = spec.owner.as_deref().filter(|o| !o.is_empty()) {
                    out.push(self.authorization(name, o));
                }
                if let Some(to) = spec.rename_to.as_deref().filter(|t| *t != name) {
                    out.push(format!("ALTER DATABASE {id} MODIFY NAME = {}", self.id(to)));
                }
            }
            _ => {
                if let Some(c) = spec.comment.as_deref() {
                    out.push(format!("ALTER DATABASE {id} MODIFY COMMENT {}", self.lit(c)));
                }
                if let Some(to) = spec.rename_to.as_deref().filter(|t| *t != name) {
                    out.push(format!("RENAME DATABASE {id} TO {}", self.id(to)));
                }
            }
        }
        if out.is_empty() {
            return Err("nothing to change".to_owned());
        }
        Ok(out)
    }

    fn drop(
        &self,
        name: &str,
        force: bool,
        current: Option<&str>,
    ) -> Result<Vec<String>, Unsupported> {
        let name = named(name)?;
        if current == Some(name) {
            return Err("the session is connected to this database: open another first".to_owned());
        }
        if force && !self.allowed.force_drop {
            return Err("this database cannot end the sessions connected to it".to_owned());
        }
        let id = self.id(name);
        Ok(match (self.dialect, force) {
            (Dialect::Postgres, true) => vec![format!("DROP DATABASE {id} WITH (FORCE)")],
            (Dialect::SqlServer, true) => vec![
                format!("ALTER DATABASE {id} SET SINGLE_USER WITH ROLLBACK IMMEDIATE"),
                format!("DROP DATABASE {id}"),
            ],
            _ => vec![format!("DROP DATABASE {id}")],
        })
    }

    /// Appends ` KEYWORD value` when `value` is set; the value is an identifier or a literal.
    fn opt(&self, sql: &mut String, keyword: &str, value: Option<&str>, ident: bool) {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            let v = if ident { self.id(v) } else { self.lit(v) };
            sql.push_str(&format!(" {keyword} {v}"));
        }
    }

    fn comment(&self, out: &mut Vec<String>, name: &str, comment: Option<&str>) {
        if let Some(c) = comment {
            let text = if c.is_empty() {
                "NULL".to_owned()
            } else {
                self.lit(c)
            };
            out.push(format!("COMMENT ON DATABASE {} IS {text}", self.id(name)));
        }
    }

    fn authorization(&self, name: &str, owner: &str) -> String {
        format!(
            "ALTER AUTHORIZATION ON DATABASE::{} TO {}",
            self.id(name),
            self.id(owner)
        )
    }
}

const NAME: &str = "the database needs a name";

fn named(name: &str) -> Result<&str, Unsupported> {
    if name.trim().is_empty() {
        Err(NAME.to_owned())
    } else {
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> DatabaseSpec {
        DatabaseSpec {
            name: name.to_owned(),
            ..DatabaseSpec::default()
        }
    }

    fn run(d: Dialect, c: &DatabaseChange) -> Result<Vec<String>, Unsupported> {
        statements(d, c, None)
    }

    #[test]
    fn postgres_create_with_options() {
        let mut s = spec("shop");
        s.owner = Some("app".into());
        s.encoding = Some("UTF8".into());
        s.connection_limit = Some(10);
        s.comment = Some("it's".into());
        let out = run(Dialect::Postgres, &DatabaseChange::Create { spec: s }).unwrap();
        assert_eq!(
            out,
            vec![
                "CREATE DATABASE \"shop\" OWNER \"app\" ENCODING 'UTF8' CONNECTION LIMIT 10"
                    .to_owned(),
                "COMMENT ON DATABASE \"shop\" IS 'it''s'".to_owned()
            ]
        );
    }

    #[test]
    fn postgres_alter_renames_last_and_refuses_encoding() {
        let mut s = spec("a");
        s.owner = Some("b".into());
        s.rename_to = Some("c".into());
        let out = run(Dialect::Postgres, &DatabaseChange::Alter { spec: s }).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out[1].ends_with("RENAME TO \"c\""));
        let mut s = spec("a");
        s.encoding = Some("LATIN1".into());
        assert!(run(Dialect::Postgres, &DatabaseChange::Alter { spec: s }).is_err());
    }

    #[test]
    fn mysql_create_alter_and_unsupported() {
        let mut s = spec("shop");
        s.encoding = Some("utf8mb4".into());
        s.collation = Some("utf8mb4_bin".into());
        let out = run(Dialect::MySql, &DatabaseChange::Create { spec: s.clone() }).unwrap();
        assert_eq!(
            out[0],
            "CREATE DATABASE `shop` CHARACTER SET 'utf8mb4' COLLATE 'utf8mb4_bin'"
        );
        assert!(run(Dialect::MySql, &DatabaseChange::Alter { spec: s }).is_ok());
        let mut o = spec("x");
        o.owner = Some("me".into());
        assert!(run(Dialect::MySql, &DatabaseChange::Create { spec: o }).is_err());
        assert!(run(Dialect::MySql, &DatabaseChange::Alter { spec: spec("x") }).is_err());
    }

    #[test]
    fn drop_variants_and_guards() {
        let d = |n: &str, force| DatabaseChange::Drop {
            name: n.to_owned(),
            force,
        };
        assert_eq!(
            run(Dialect::Postgres, &d("a", true)).unwrap(),
            vec!["DROP DATABASE \"a\" WITH (FORCE)"]
        );
        assert_eq!(run(Dialect::SqlServer, &d("a", true)).unwrap().len(), 2);
        assert!(run(Dialect::MySql, &d("a", true)).is_err());
        assert!(run(Dialect::MySql, &d(" ", false)).is_err());
        assert!(statements(Dialect::MySql, &d("a", false), Some("a")).is_err());
        assert!(run(Dialect::Sqlite, &d("a", false)).is_err());
    }

    #[test]
    fn sqlserver_and_clickhouse() {
        let mut s = spec("a");
        s.owner = Some("sa".into());
        s.collation = Some("Latin1_General_CI_AS".into());
        let out = run(Dialect::SqlServer, &DatabaseChange::Create { spec: s }).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out[1].starts_with("ALTER AUTHORIZATION ON DATABASE::[a]"));
        let mut s = spec("a");
        s.rename_to = Some("b".into());
        let out = run(Dialect::ClickHouse, &DatabaseChange::Alter { spec: s }).unwrap();
        assert_eq!(out, vec!["RENAME DATABASE `a` TO `b`"]);
    }
}
