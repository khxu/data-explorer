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

    /// Replace all registered table name references in the SQL with inline
    /// read_parquet/read_csv/read_json_auto calls. This produces fully
    /// self-contained SQL that can run in the DuckDB CLI without any CTEs.
    pub fn inline_sources(&self, user_sql: &str) -> Result<String, AppError> {
        let sources = self.sources.lock().unwrap();
        if sources.is_empty() {
            return Ok(user_sql.to_string());
        }

        // Sort by name length descending so longer names are replaced first,
        // preventing partial matches (e.g., "rs_graph_document" matching inside
        // "rs_graph_document_repository_link")
        let mut sorted: Vec<(&String, &SourceInfo)> = sources.iter().collect();
        sorted.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

        let mut result = user_sql.to_string();
        for (name, info) in &sorted {
            let read_fn = Self::read_fn_for(&info.file_path, &info.file_format)?;
            // Replace table name references that appear as whole identifiers.
            // We look for the name bounded by non-identifier characters.
            let mut new_result = String::new();
            let mut remaining = result.as_str();
            while let Some(pos) = remaining.find(name.as_str()) {
                // Check character before the match
                let before_ok = if pos == 0 {
                    true
                } else {
                    let ch = remaining.as_bytes()[pos - 1] as char;
                    !ch.is_alphanumeric() && ch != '_'
                };
                // Check character after the match
                let after_pos = pos + name.len();
                let after_ok = if after_pos >= remaining.len() {
                    true
                } else {
                    let ch = remaining.as_bytes()[after_pos] as char;
                    !ch.is_alphanumeric() && ch != '_'
                };

                if before_ok && after_ok {
                    new_result.push_str(&remaining[..pos]);
                    new_result.push_str(&read_fn);
                    remaining = &remaining[after_pos..];
                } else {
                    new_result.push_str(&remaining[..after_pos]);
                    remaining = &remaining[after_pos..];
                }
            }
            new_result.push_str(remaining);
            result = new_result;
        }

        Ok(result)
    }
}
