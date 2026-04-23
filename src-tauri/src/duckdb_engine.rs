use duckdb::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::AppError;

#[derive(Clone)]
struct SourceInfo {
    file_path: String,
    file_format: String,
}

pub struct DuckDbEngine {
    pub conn: Mutex<Connection>,
    /// Registered data sources: name → (file_path, file_format).
    /// Used to build CTE-prefixed queries that bypass catalog resolution.
    sources: Mutex<HashMap<String, SourceInfo>>,
}

impl DuckDbEngine {
    pub fn new() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        Ok(Self {
            conn: Mutex::new(conn),
            sources: Mutex::new(HashMap::new()),
        })
    }

    fn read_fn_for(file_path: &str, file_format: &str) -> Result<String, AppError> {
        match file_format {
            "parquet" => Ok(format!("read_parquet('{}')", file_path.replace('\'', "''"))),
            "csv" => Ok(format!("read_csv('{}')", file_path.replace('\'', "''"))),
            "json" | "jsonl" | "ndjson" => {
                Ok(format!("read_json_auto('{}')", file_path.replace('\'', "''")))
            }
            _ => Err(AppError::General(format!(
                "Unsupported file format: {}",
                file_format
            ))),
        }
    }

    /// Register a data source so it can be referenced in queries.
    pub fn register_source(
        &self,
        name: &str,
        file_path: &str,
        file_format: &str,
    ) -> Result<(), AppError> {
        // Validate the format early
        Self::read_fn_for(file_path, file_format)?;

        self.sources.lock().unwrap().insert(
            name.to_string(),
            SourceInfo {
                file_path: file_path.to_string(),
                file_format: file_format.to_string(),
            },
        );
        Ok(())
    }

    /// Unregister a data source.
    pub fn unregister_source(&self, name: &str) -> Result<(), AppError> {
        self.sources.lock().unwrap().remove(name);
        Ok(())
    }

    /// Build a CTE prefix that makes all registered sources available as
    /// named tables. This completely bypasses catalog resolution, avoiding
    /// the duckdb crate's `prepare` / `duckdb_extract_statements` path
    /// which fails to resolve catalog entries for queries with WHERE clauses.
    pub fn wrap_query(&self, user_sql: &str) -> Result<String, AppError> {
        let sources = self.sources.lock().unwrap();
        if sources.is_empty() {
            return Ok(user_sql.to_string());
        }

        let mut cte_parts: Vec<String> = Vec::new();
        for (name, info) in sources.iter() {
            let read_fn = Self::read_fn_for(&info.file_path, &info.file_format)?;
            cte_parts.push(format!("{} AS (SELECT * FROM {})", name, read_fn));
        }
        let cte_block = cte_parts.join(", ");

        // If user query already starts with WITH, merge CTE lists
        let trimmed = user_sql.trim_start();
        let sql = if trimmed.len() >= 4
            && trimmed[..4].eq_ignore_ascii_case("with")
            && trimmed.as_bytes().get(4).map_or(false, |b| b.is_ascii_whitespace())
        {
            // Replace the leading WITH with our CTEs + comma
            format!("WITH {}, {}", cte_block, &trimmed[4..].trim_start())
        } else {
            format!("WITH {} {}", cte_block, user_sql)
        };

        Ok(sql)
    }
}
