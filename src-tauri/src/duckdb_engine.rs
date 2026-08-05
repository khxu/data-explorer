use duckdb::{Connection, InterruptHandle};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::error::AppError;

#[derive(Clone)]
struct SourceInfo {
    file_paths: Vec<String>,
    file_format: String,
}

pub struct DuckDbEngine {
    pub conn: Mutex<Connection>,
    /// Registered data sources: name → (file_paths, file_format).
    /// Used to build CTE-prefixed queries that bypass catalog resolution.
    sources: Mutex<HashMap<String, SourceInfo>>,
    active_query: Mutex<Option<Arc<InterruptHandle>>>,
    retained_result_tables: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
pub struct SourcePreview {
    pub columns: Vec<(String, String)>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone)]
enum SqlTokenKind {
    Word { value: String, quoted: bool },
    Symbol(char),
}

#[derive(Debug, Clone)]
struct SqlToken {
    kind: SqlTokenKind,
    start: usize,
    end: usize,
}

pub struct ActiveQueryGuard<'a> {
    engine: &'a DuckDbEngine,
}

impl Drop for ActiveQueryGuard<'_> {
    fn drop(&mut self) {
        self.engine.clear_active_query();
    }
}

impl DuckDbEngine {
    pub fn new() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "SET disabled_optimizers = 'compressed_materialization';
             LOAD icu",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            sources: Mutex::new(HashMap::new()),
            active_query: Mutex::new(None),
            retained_result_tables: Mutex::new(HashSet::new()),
        })
    }

    pub fn activate_query(&self, interrupt_handle: Arc<InterruptHandle>) -> ActiveQueryGuard<'_> {
        *self.active_query.lock().unwrap() = Some(interrupt_handle);
        ActiveQueryGuard { engine: self }
    }

    pub fn cancel_active_query(&self) -> bool {
        let active_query = self.active_query.lock().unwrap().clone();
        if let Some(interrupt_handle) = active_query {
            interrupt_handle.interrupt();
            true
        } else {
            false
        }
    }

    fn clear_active_query(&self) {
        *self.active_query.lock().unwrap() = None;
    }

    fn read_fn_for(file_paths: &[String], file_format: &str) -> Result<String, AppError> {
        if file_paths.is_empty() {
            return Err(AppError::General(
                "A data source must contain at least one file.".to_string(),
            ));
        }
        let paths = file_paths
            .iter()
            .map(|path| format!("'{}'", path.replace('\'', "''")))
            .collect::<Vec<_>>();
        let path_arg = if paths.len() == 1 {
            paths[0].clone()
        } else {
            format!("[{}]", paths.join(", "))
        };
        match file_format {
            "parquet" => Ok(format!("read_parquet({})", path_arg)),
            "csv" => Ok(format!("read_csv({})", path_arg)),
            "json" | "jsonl" | "ndjson" => Ok(format!("read_json_auto({})", path_arg)),
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
        file_paths: &[String],
        file_format: &str,
    ) -> Result<(), AppError> {
        // Validate the format early
        Self::read_fn_for(file_paths, file_format)?;

        self.sources.lock().unwrap().insert(
            name.to_string(),
            SourceInfo {
                file_paths: file_paths.to_vec(),
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

    pub fn columns_for_source(
        &self,
        file_paths: &[String],
        file_format: &str,
    ) -> Result<Vec<(String, String)>, AppError> {
        Ok(self.preview_source(file_paths, file_format, 0)?.columns)
    }

    pub fn preview_source(
        &self,
        file_paths: &[String],
        file_format: &str,
        limit: usize,
    ) -> Result<SourcePreview, AppError> {
        let read_fn = Self::read_fn_for(file_paths, file_format)?;
        let sql = format!("SELECT * FROM {} LIMIT {}", read_fn, limit);
        self.query_raw_rows(&sql)
    }

    pub fn source_rows(
        &self,
        file_paths: &[String],
        file_format: &str,
        limit: Option<usize>,
    ) -> Result<SourcePreview, AppError> {
        let read_fn = Self::read_fn_for(file_paths, file_format)?;
        let sql = if let Some(limit) = limit {
            format!("SELECT * FROM {} LIMIT {}", read_fn, limit)
        } else {
            format!("SELECT * FROM {}", read_fn)
        };
        self.query_raw_rows(&sql)
    }

    fn query_raw_rows(&self, sql: &str) -> Result<SourcePreview, AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let mut result_rows = stmt.query([])?;
        let mut rows = Vec::new();
        let mut column_count = 0;

        while let Some(row) = result_rows.next()? {
            if column_count == 0 {
                column_count = row.as_ref().column_count();
            }
            let mut row_data = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let val: duckdb::types::Value = row.get(i)?;
                row_data.push(Self::duckdb_value_to_json(val));
            }
            rows.push(row_data);
        }

        drop(result_rows);

        if column_count == 0 {
            column_count = stmt.column_count();
        }
        let columns = (0..column_count)
            .map(|i| {
                (
                    stmt.column_name(i)
                        .map_or("?".to_string(), |name| name.to_string()),
                    format!("{}", stmt.column_type(i)),
                )
            })
            .collect();

        Ok(SourcePreview { columns, rows })
    }

    pub fn query_rows(
        &self,
        user_sql: &str,
        limit: Option<usize>,
    ) -> Result<SourcePreview, AppError> {
        let wrapped_sql = self.wrap_query_for_embedding(user_sql)?;
        let sql = if let Some(limit) = limit {
            format!(
                "SELECT * FROM ({}) AS llm_input LIMIT {}",
                wrapped_sql, limit
            )
        } else {
            wrapped_sql
        };
        let temp_table = format!("__llm_input_{}", uuid::Uuid::new_v4().simple());
        let create_sql = format!("CREATE TEMP TABLE \"{}\" AS {}", temp_table, sql);
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(&create_sql)?;

        let select_sql = format!("SELECT * FROM \"{}\"", temp_table);
        let mut stmt = conn.prepare(&select_sql)?;
        let mut result_rows = stmt.query([])?;
        let mut rows = Vec::new();
        let mut column_count = 0;

        while let Some(row) = result_rows.next()? {
            if column_count == 0 {
                column_count = row.as_ref().column_count();
            }
            let mut row_data = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let val: duckdb::types::Value = row.get(i)?;
                row_data.push(Self::duckdb_value_to_json(val));
            }
            rows.push(row_data);
        }

        drop(result_rows);

        if column_count == 0 {
            column_count = stmt.column_count();
        }
        let columns = (0..column_count)
            .map(|i| {
                (
                    stmt.column_name(i)
                        .map_or("?".to_string(), |name| name.to_string()),
                    format!("{}", stmt.column_type(i)),
                )
            })
            .collect();

        drop(stmt);
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS {}",
            Self::quote_identifier(&temp_table)
        ))?;

        Ok(SourcePreview { columns, rows })
    }

    fn duckdb_value_to_json(val: duckdb::types::Value) -> serde_json::Value {
        match val {
            duckdb::types::Value::Null => serde_json::Value::Null,
            duckdb::types::Value::Boolean(b) => serde_json::Value::Bool(b),
            duckdb::types::Value::TinyInt(i) => serde_json::json!(i),
            duckdb::types::Value::SmallInt(i) => serde_json::json!(i),
            duckdb::types::Value::Int(i) => serde_json::json!(i),
            duckdb::types::Value::BigInt(i) => serde_json::json!(i),
            duckdb::types::Value::Float(f) => serde_json::json!(f),
            duckdb::types::Value::Double(f) => serde_json::json!(f),
            duckdb::types::Value::Text(s) => serde_json::Value::String(s),
            _ => serde_json::Value::String(format!("{:?}", val)),
        }
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
            let read_fn = Self::read_fn_for(&info.file_paths, &info.file_format)?;
            cte_parts.push(format!("{} AS (SELECT * FROM {})", name, read_fn));
        }
        let cte_block = cte_parts.join(", ");

        // If user query already starts with WITH, merge CTE lists
        let trimmed = user_sql.trim_start();
        let sql = if trimmed.len() >= 4
            && trimmed[..4].eq_ignore_ascii_case("with")
            && trimmed
                .as_bytes()
                .get(4)
                .map_or(false, |b| b.is_ascii_whitespace())
        {
            // Replace the leading WITH with our CTEs + comma
            format!("WITH {}, {}", cte_block, &trimmed[4..].trim_start())
        } else {
            format!("WITH {} {}", cte_block, user_sql)
        };

        Ok(sql)
    }

    /// Return SQL that can be embedded inside another statement, such as
    /// `COPY (<query>) TO ...` or `CREATE TABLE AS <query>`.
    pub fn wrap_query_for_embedding(&self, user_sql: &str) -> Result<String, AppError> {
        let wrapped_sql = self.wrap_query(user_sql)?;
        Ok(Self::trim_trailing_statement_terminators(&wrapped_sql).to_string())
    }

    fn trim_trailing_statement_terminators(sql: &str) -> &str {
        let mut trimmed = sql.trim_end();
        while let Some(without_semicolon) = trimmed.strip_suffix(';') {
            trimmed = without_semicolon.trim_end();
        }
        trimmed
    }

    fn quote_identifier(identifier: &str) -> String {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }

    fn is_retained_result_table_name(table_name: &str) -> bool {
        table_name.starts_with("__qr_")
            && table_name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    }

    pub fn retain_result_table(&self, table_name: &str) -> Result<(), AppError> {
        if !Self::is_retained_result_table_name(table_name) {
            return Err(AppError::General(format!(
                "Invalid query result table name: {}",
                table_name
            )));
        }
        self.retained_result_tables
            .lock()
            .unwrap()
            .insert(table_name.to_string());
        Ok(())
    }

    pub fn retained_result_table_query(&self, table_name: &str) -> Result<String, AppError> {
        if !Self::is_retained_result_table_name(table_name) {
            return Err(AppError::General(format!(
                "Invalid query result table name: {}",
                table_name
            )));
        }
        if !self
            .retained_result_tables
            .lock()
            .unwrap()
            .contains(table_name)
        {
            return Err(AppError::General(
                "The query result is no longer available. Run the query again before exporting."
                    .to_string(),
            ));
        }
        Ok(format!(
            "SELECT * FROM {}",
            Self::quote_identifier(table_name)
        ))
    }

    pub fn release_result_table(&self, table_name: &str) -> Result<bool, AppError> {
        if !Self::is_retained_result_table_name(table_name) {
            return Err(AppError::General(format!(
                "Invalid query result table name: {}",
                table_name
            )));
        }
        let removed = self
            .retained_result_tables
            .lock()
            .unwrap()
            .remove(table_name);
        if removed {
            let conn = self.conn.lock().unwrap();
            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {}",
                Self::quote_identifier(table_name)
            ))?;
        }
        Ok(removed)
    }

    /// Replace registered source references in relation positions with inline
    /// read_parquet/read_csv/read_json_auto calls. Column qualifiers keep using
    /// the original source name through an alias on the table function.
    pub fn inline_sources(&self, user_sql: &str) -> Result<String, AppError> {
        let sources = self.sources.lock().unwrap();
        if sources.is_empty() {
            return Ok(user_sql.to_string());
        }

        let source_lookup: HashMap<String, (&String, &SourceInfo)> = sources
            .iter()
            .map(|(name, info)| (name.to_ascii_lowercase(), (name, info)))
            .collect();
        let tokens = Self::tokenize_sql(user_sql);
        let mut replacements: Vec<(usize, usize, String)> = Vec::new();

        let mut next_relation = false;
        let mut in_from_list = false;
        for (index, token) in tokens.iter().enumerate() {
            if let SqlTokenKind::Word { value, .. } = &token.kind {
                if is_relation_keyword(value) {
                    next_relation = true;
                    in_from_list = false;
                    continue;
                }

                if is_clause_boundary_keyword(value) {
                    next_relation = false;
                    in_from_list = false;
                    continue;
                }
            }

            if matches!(token.kind, SqlTokenKind::Symbol(',') if in_from_list) {
                next_relation = true;
                continue;
            }

            if !next_relation {
                continue;
            }

            match &token.kind {
                SqlTokenKind::Word { value, quoted } => {
                    if Self::token_is_part_of_qualified_name(&tokens, index) {
                        next_relation = false;
                        in_from_list = false;
                        continue;
                    }

                    if let Some((source_name, info)) =
                        source_lookup.get(&value.to_ascii_lowercase())
                    {
                        let read_fn = Self::read_fn_for(&info.file_paths, &info.file_format)?;
                        let replacement = if Self::has_explicit_alias(&tokens, index) {
                            read_fn
                        } else {
                            let alias = if *quoted {
                                user_sql[token.start..token.end].to_string()
                            } else {
                                source_name.to_string()
                            };
                            format!("{} AS {}", read_fn, alias)
                        };
                        replacements.push((token.start, token.end, replacement));
                        in_from_list = true;
                    } else {
                        in_from_list = false;
                    }
                    next_relation = false;
                }
                SqlTokenKind::Symbol('(') => {
                    next_relation = false;
                    in_from_list = true;
                }
                _ => {
                    next_relation = false;
                    in_from_list = false;
                }
            }
        }

        Ok(Self::apply_replacements(user_sql, &replacements))
    }

    fn apply_replacements(sql: &str, replacements: &[(usize, usize, String)]) -> String {
        if replacements.is_empty() {
            return sql.to_string();
        }

        let mut result = String::with_capacity(sql.len());
        let mut cursor = 0;
        for (start, end, replacement) in replacements {
            result.push_str(&sql[cursor..*start]);
            result.push_str(replacement);
            cursor = *end;
        }
        result.push_str(&sql[cursor..]);
        result
    }

    fn token_is_part_of_qualified_name(tokens: &[SqlToken], index: usize) -> bool {
        matches!(
            tokens.get(index.wrapping_sub(1)).map(|t| &t.kind),
            Some(SqlTokenKind::Symbol('.'))
        ) || matches!(
            tokens.get(index + 1).map(|t| &t.kind),
            Some(SqlTokenKind::Symbol('.'))
        )
    }

    fn has_explicit_alias(tokens: &[SqlToken], index: usize) -> bool {
        match tokens.get(index + 1).map(|token| &token.kind) {
            Some(SqlTokenKind::Word { value, .. }) if value.eq_ignore_ascii_case("as") => true,
            Some(SqlTokenKind::Word { value, .. }) => !is_clause_boundary_keyword(value),
            _ => false,
        }
    }

    fn tokenize_sql(sql: &str) -> Vec<SqlToken> {
        let mut tokens = Vec::new();
        let mut iter = sql.char_indices().peekable();

        while let Some((start, ch)) = iter.next() {
            if ch.is_whitespace() {
                continue;
            }

            if ch == '-' && matches!(iter.peek(), Some((_, '-'))) {
                iter.next();
                for (_, next_ch) in iter.by_ref() {
                    if next_ch == '\n' {
                        break;
                    }
                }
                continue;
            }

            if ch == '/' && matches!(iter.peek(), Some((_, '*'))) {
                iter.next();
                let mut previous = '\0';
                for (_, next_ch) in iter.by_ref() {
                    if previous == '*' && next_ch == '/' {
                        break;
                    }
                    previous = next_ch;
                }
                continue;
            }

            if ch == '\'' {
                while let Some((_, next_ch)) = iter.next() {
                    if next_ch == '\'' {
                        if matches!(iter.peek(), Some((_, '\''))) {
                            iter.next();
                        } else {
                            break;
                        }
                    }
                }
                continue;
            }

            if ch == '"' {
                let mut value = String::new();
                let mut end = sql.len();
                while let Some((idx, next_ch)) = iter.next() {
                    if next_ch == '"' {
                        if matches!(iter.peek(), Some((_, '"'))) {
                            value.push('"');
                            iter.next();
                        } else {
                            end = idx + next_ch.len_utf8();
                            break;
                        }
                    } else {
                        value.push(next_ch);
                    }
                }
                tokens.push(SqlToken {
                    kind: SqlTokenKind::Word {
                        value,
                        quoted: true,
                    },
                    start,
                    end,
                });
                continue;
            }

            if is_identifier_start(ch) {
                let mut value = String::new();
                value.push(ch);
                let mut end = start + ch.len_utf8();
                while let Some((idx, next_ch)) = iter.peek().copied() {
                    if is_identifier_part(next_ch) {
                        value.push(next_ch);
                        end = idx + next_ch.len_utf8();
                        iter.next();
                    } else {
                        break;
                    }
                }
                tokens.push(SqlToken {
                    kind: SqlTokenKind::Word {
                        value,
                        quoted: false,
                    },
                    start,
                    end,
                });
                continue;
            }

            if matches!(ch, '(' | ')' | ',' | '.') {
                tokens.push(SqlToken {
                    kind: SqlTokenKind::Symbol(ch),
                    start,
                    end: start + ch.len_utf8(),
                });
            }
        }

        tokens
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_identifier_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn is_relation_keyword(value: &str) -> bool {
    value.eq_ignore_ascii_case("from") || value.eq_ignore_ascii_case("join")
}

fn is_clause_boundary_keyword(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "on" | "using"
            | "where"
            | "join"
            | "inner"
            | "left"
            | "right"
            | "full"
            | "cross"
            | "natural"
            | "semi"
            | "anti"
            | "group"
            | "order"
            | "having"
            | "limit"
            | "offset"
            | "qualify"
            | "window"
            | "union"
            | "except"
            | "intersect"
            | "sample"
            | "tablesample"
            | "pivot"
            | "unpivot"
    )
}

#[cfg(test)]
mod tests {
    use super::DuckDbEngine;

    #[test]
    fn disables_compressed_materialization_optimizer() {
        let engine = DuckDbEngine::new().unwrap();
        let conn = engine.conn.lock().unwrap();
        let disabled: String = conn
            .query_row(
                "SELECT value
                 FROM duckdb_settings()
                 WHERE name = 'disabled_optimizers'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(disabled
            .split(',')
            .any(|optimizer| optimizer == "compressed_materialization"));
    }

    #[test]
    fn trims_trailing_statement_terminators_for_embedded_queries() {
        assert_eq!(
            DuckDbEngine::trim_trailing_statement_terminators("SELECT ';' AS value;\n  "),
            "SELECT ';' AS value"
        );
        assert_eq!(
            DuckDbEngine::trim_trailing_statement_terminators("SELECT 1;;  "),
            "SELECT 1"
        );
        assert_eq!(
            DuckDbEngine::trim_trailing_statement_terminators("SELECT 1"),
            "SELECT 1"
        );
    }

    #[test]
    fn query_with_trailing_semicolon_can_be_used_in_copy() {
        let engine = DuckDbEngine::new().unwrap();
        let wrapped_sql = engine
            .wrap_query_for_embedding(
                "WITH values_to_export AS (SELECT 1 AS id) SELECT * FROM values_to_export;",
            )
            .unwrap();
        let destination = std::env::temp_dir().join(format!(
            "data_explorer_export_semicolon_{}.csv",
            uuid::Uuid::new_v4().simple()
        ));
        let destination_sql = destination.to_string_lossy().replace('\'', "''");
        let copy_sql = format!(
            "COPY ({}) TO '{}' (FORMAT CSV, HEADER)",
            wrapped_sql, destination_sql
        );

        {
            let conn = engine.conn.lock().unwrap();
            conn.execute_batch(&copy_sql).unwrap();
        }

        let exported = std::fs::read_to_string(&destination).unwrap();
        std::fs::remove_file(destination).unwrap();
        assert_eq!(exported, "id\n1\n");
    }

    #[test]
    fn columns_for_source_executes_before_reading_column_types() {
        let engine = DuckDbEngine::new().unwrap();
        let source = std::env::temp_dir().join(format!(
            "data_explorer_schema_{}.csv",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&source, "id,name\n1,Ada\n").unwrap();

        let columns = engine
            .columns_for_source(&[source.to_string_lossy().into_owned()], "csv")
            .unwrap();

        std::fs::remove_file(source).unwrap();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].0, "id");
        assert_eq!(columns[1].0, "name");
    }

    #[test]
    fn registered_source_reads_multiple_parquet_files_as_one_table() {
        let engine = DuckDbEngine::new().unwrap();
        let source_prefix = std::env::temp_dir().join(format!(
            "data_explorer_multi_source_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let first = source_prefix.with_extension("1.parquet");
        let second = source_prefix.with_extension("2.parquet");

        {
            let conn = engine.conn.lock().unwrap();
            conn.execute_batch(&format!(
                "COPY (SELECT 1 AS id) TO '{}' (FORMAT PARQUET);
                 COPY (SELECT 2 AS id) TO '{}' (FORMAT PARQUET);",
                first.to_string_lossy().replace('\'', "''"),
                second.to_string_lossy().replace('\'', "''")
            ))
            .unwrap();
        }

        let paths = vec![
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];
        engine
            .register_source("partitioned_data", &paths, "parquet")
            .unwrap();

        let result = engine
            .query_rows("SELECT id FROM partitioned_data ORDER BY id", None)
            .unwrap();

        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][0], serde_json::json!(1));
        assert_eq!(result.rows[1][0], serde_json::json!(2));
    }

    #[test]
    fn strftime_date_trunc_on_registered_timestamptz_source() {
        let engine = DuckDbEngine::new().unwrap();
        let source = std::env::temp_dir().join(format!(
            "data_explorer_timestamptz_{}.parquet",
            uuid::Uuid::new_v4().simple()
        ));
        let source_sql = source.to_string_lossy().replace('\'', "''");

        {
            let conn = engine.conn.lock().unwrap();
            conn.execute_batch(&format!(
                "COPY (
                    SELECT '2024-01-15T12:00:00Z'::TIMESTAMPTZ AS created_at
                    UNION ALL
                    SELECT '2024-02-15T12:00:00Z'::TIMESTAMPTZ AS created_at
                ) TO '{}' (FORMAT PARQUET)",
                source_sql
            ))
            .unwrap();
        }

        engine
            .register_source(
                "openssf_agent_prs",
                &[source.to_string_lossy().into_owned()],
                "parquet",
            )
            .unwrap();

        let result = engine
            .query_rows(
                "SELECT
                    strftime(date_trunc('month', created_at), '%Y-%m') AS month_created,
                    COUNT(*) AS row_count
                FROM openssf_agent_prs
                GROUP BY 1
                ORDER BY 1 ASC",
                None,
            )
            .unwrap();

        std::fs::remove_file(source).unwrap();
        assert_eq!(result.rows.len(), 2);
    }

    #[test]
    fn inline_sources_aliases_table_functions_in_relations_only() {
        let engine = DuckDbEngine::new().unwrap();
        engine
            .register_source(
                "github_policy_keywords",
                &["/tmp/policy-keywords.csv".to_string()],
                "csv",
            )
            .unwrap();
        engine
            .register_source(
                "searchablebill",
                &["/tmp/searchablebill.parquet".to_string()],
                "parquet",
            )
            .unwrap();

        let sql = "WITH policy_keywords AS (
  SELECT keyword FROM github_policy_keywords
)
SELECT policy_keywords.keyword,
  searchablebill.raw_text[:140] AS raw_text_sample
FROM searchablebill
JOIN policy_keywords ON LOWER(searchablebill.raw_text) LIKE policy_keywords.keyword";

        let standalone = engine.inline_sources(sql).unwrap();

        assert!(standalone
            .contains("FROM read_csv('/tmp/policy-keywords.csv') AS github_policy_keywords"));
        assert!(standalone
            .contains("FROM read_parquet('/tmp/searchablebill.parquet') AS searchablebill"));
        assert!(standalone.contains("JOIN policy_keywords ON"));
        assert!(standalone.contains("searchablebill.raw_text[:140]"));
        assert!(!standalone.contains("read_parquet('/tmp/searchablebill.parquet').raw_text"));
    }

    #[test]
    fn inline_sources_preserves_explicit_aliases() {
        let engine = DuckDbEngine::new().unwrap();
        engine
            .register_source(
                "searchablebill",
                &["/tmp/searchablebill.parquet".to_string()],
                "parquet",
            )
            .unwrap();

        let standalone = engine
            .inline_sources(
                "SELECT sb.raw_text FROM searchablebill AS sb WHERE sb.raw_text IS NOT NULL",
            )
            .unwrap();

        assert_eq!(
            standalone,
            "SELECT sb.raw_text FROM read_parquet('/tmp/searchablebill.parquet') AS sb WHERE sb.raw_text IS NOT NULL"
        );
    }
}
