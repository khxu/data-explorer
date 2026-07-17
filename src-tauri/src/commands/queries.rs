use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tauri::State;

use crate::commands::data_sources::deserialize_file_paths;
use crate::db::Database;
use crate::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub execution_time_ms: u64,
    pub export_table_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueryHistoryEntry {
    pub id: String,
    pub sql_text: String,
    pub status: String,
    pub error_message: Option<String>,
    pub row_count: Option<i64>,
    pub execution_time_ms: Option<i64>,
    pub result_sample: Option<String>,
    pub created_at: String,
}

const MAX_SAMPLE_ROWS: usize = 20;
const MAX_SAMPLE_COL_LEN: usize = 200;

fn truncate_value(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::String(s) if s.len() > MAX_SAMPLE_COL_LEN => {
            serde_json::Value::String(format!("{}…", &s[..MAX_SAMPLE_COL_LEN]))
        }
        other => other.clone(),
    }
}

fn execute_duckdb_query(duckdb: &DuckDbEngine, sql: &str) -> Result<QueryResult, AppError> {
    // Wrap user SQL with CTEs for all registered data sources.
    let wrapped_sql = duckdb.wrap_query_for_embedding(sql)?;

    let conn = duckdb.conn.lock().unwrap();
    let _active_query = duckdb.activate_query(conn.interrupt_handle());

    // The duckdb crate's conn.prepare() uses duckdb_extract_statements which
    // has a bug where CTEs + WHERE clauses fail with "Table does not exist".
    // Workaround: use execute_batch (which goes through duckdb_query_arrow and
    // works correctly) to materialize results into a temp table, then read
    // from that table with a trivial SELECT that prepare() can handle.
    let temp_table = format!("__qr_{}", uuid::Uuid::new_v4().simple());

    let create_sql = format!("CREATE TEMP TABLE \"{}\" AS {}", temp_table, wrapped_sql);

    let start = Instant::now();
    conn.execute_batch(&create_sql)?;
    let elapsed = start.elapsed().as_millis() as u64;

    // Now read from the temp table — this is a simple query that prepare() handles fine
    let select_sql = format!("SELECT * FROM \"{}\"", temp_table);
    let mut stmt = conn.prepare(&select_sql)?;
    let mut result_rows = stmt.query([])?;

    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut column_count = 0;

    while let Some(row) = result_rows.next()? {
        if column_count == 0 {
            column_count = row.as_ref().column_count();
        }
        let mut row_data = Vec::with_capacity(column_count);
        for i in 0..column_count {
            let val: duckdb::types::Value = row.get(i)?;
            row_data.push(duckdb_value_to_json(val));
        }
        rows.push(row_data);
    }

    // Drop the Rows borrow so we can access stmt for column names
    drop(result_rows);

    // Get column names from the executed statement
    if column_count == 0 {
        column_count = stmt.column_count();
    }
    let columns: Vec<String> = (0..column_count)
        .map(|i| {
            stmt.column_name(i)
                .map_or("?".to_string(), |v| v.to_string())
        })
        .collect();
    let column_types: Vec<String> = (0..column_count)
        .map(|i| format!("{}", stmt.column_type(i)))
        .collect();

    drop(stmt);

    duckdb.retain_result_table(&temp_table)?;

    Ok(QueryResult {
        columns,
        column_types,
        row_count: rows.len(),
        rows,
        execution_time_ms: elapsed,
        export_table_name: Some(temp_table),
    })
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

fn execute_query_blocking(
    db: &Database,
    duckdb: &DuckDbEngine,
    sql: String,
) -> Result<QueryResult, AppError> {
    let result = execute_duckdb_query(duckdb, &sql);

    // Log to history
    let history_id = uuid::Uuid::new_v4().to_string();
    let meta_conn = db.conn.lock().unwrap();

    match &result {
        Ok(qr) => {
            // Build a truncated sample
            let sample_rows: Vec<Vec<serde_json::Value>> = qr
                .rows
                .iter()
                .take(MAX_SAMPLE_ROWS)
                .map(|row| row.iter().map(truncate_value).collect())
                .collect();
            let sample = serde_json::json!({
                "columns": qr.columns,
                "rows": sample_rows,
            });
            let sample_str = serde_json::to_string(&sample).unwrap_or_default();

            meta_conn.execute(
                "INSERT INTO query_history (id, sql_text, status, row_count, execution_time_ms, result_sample)
                 VALUES (?1, ?2, 'success', ?3, ?4, ?5)",
                rusqlite::params![
                    history_id,
                    sql,
                    qr.row_count as i64,
                    qr.execution_time_ms as i64,
                    sample_str
                ],
            )?;
        }
        Err(e) => {
            meta_conn.execute(
                "INSERT INTO query_history (id, sql_text, status, error_message)
                 VALUES (?1, ?2, 'error', ?3)",
                rusqlite::params![history_id, sql, e.to_string()],
            )?;
        }
    }

    result
}

#[tauri::command]
pub async fn execute_query(
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    sql: String,
) -> Result<QueryResult, AppError> {
    let db = db.inner().clone();
    let duckdb = duckdb.inner().clone();
    tauri::async_runtime::spawn_blocking(move || execute_query_blocking(&db, &duckdb, sql))
        .await
        .map_err(|e| AppError::General(format!("Query task failed: {}", e)))?
}

#[tauri::command]
pub fn cancel_query(duckdb: State<std::sync::Arc<DuckDbEngine>>) -> Result<bool, AppError> {
    Ok(duckdb.cancel_active_query())
}

#[tauri::command]
pub fn release_query_result(
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    export_table_name: String,
) -> Result<bool, AppError> {
    duckdb.release_result_table(&export_table_name)
}

#[tauri::command]
pub fn get_standalone_sql(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    sql: String,
) -> Result<String, AppError> {
    // Ensure the in-memory source registry is fully up-to-date from SQLite
    let conn = db.conn.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT name, file_path, file_paths, file_format FROM data_sources")?;
    let sources: Vec<(String, String, Option<String>, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(conn);
    for (name, path, paths, format) in sources {
        let file_paths = deserialize_file_paths(path, paths)?;
        duckdb.register_source(&name, &file_paths, &format)?;
    }
    duckdb.inline_sources(&sql)
}

#[tauri::command]
pub fn clear_query_history(
    db: State<std::sync::Arc<Database>>,
    before: Option<String>,
) -> Result<u64, AppError> {
    let conn = db.conn.lock().unwrap();
    let affected = if let Some(before_date) = before {
        conn.execute(
            "DELETE FROM query_history WHERE created_at < ?1",
            rusqlite::params![before_date],
        )?
    } else {
        conn.execute("DELETE FROM query_history", [])?
    };
    Ok(affected as u64)
}

#[tauri::command]
pub fn get_query_history(
    db: State<std::sync::Arc<Database>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<QueryHistoryEntry>, AppError> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, sql_text, status, error_message, row_count, execution_time_ms, result_sample, created_at
         FROM query_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
        Ok(QueryHistoryEntry {
            id: row.get(0)?,
            sql_text: row.get(1)?,
            status: row.get(2)?,
            error_message: row.get(3)?,
            row_count: row.get(4)?,
            execution_time_ms: row.get(5)?,
            result_sample: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// -- Query Tab Persistence --

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedQueryTab {
    pub id: String,
    pub name: String,
    pub sql_text: String,
    pub project_id: Option<String>,
    pub sort_order: i64,
    pub is_active: bool,
    pub result_cache: Option<QueryResult>,
}

const MAX_CACHED_QUERY_RESULT_ROWS: usize = 10;

fn cache_query_result(result: &QueryResult) -> QueryResult {
    QueryResult {
        columns: result.columns.clone(),
        column_types: result.column_types.clone(),
        rows: result
            .rows
            .iter()
            .take(MAX_CACHED_QUERY_RESULT_ROWS)
            .cloned()
            .collect(),
        row_count: result.row_count,
        execution_time_ms: result.execution_time_ms,
        export_table_name: None,
    }
}

#[tauri::command]
pub fn load_query_tabs(
    db: State<std::sync::Arc<Database>>,
) -> Result<Vec<SavedQueryTab>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, sql_text, project_id, sort_order, is_active, result_cache FROM query_tabs ORDER BY sort_order",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)? != 0,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    rows.map(|row| {
        let (id, name, sql_text, project_id, sort_order, is_active, result_cache) = row?;
        Ok(SavedQueryTab {
            id,
            name,
            sql_text,
            project_id,
            sort_order,
            is_active,
            result_cache: result_cache
                .map(|json| serde_json::from_str(&json))
                .transpose()?,
        })
    })
    .collect()
}

#[tauri::command]
pub fn save_query_tabs(
    db: State<std::sync::Arc<Database>>,
    tabs: Vec<SavedQueryTab>,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM query_tabs", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO query_tabs (id, name, sql_text, project_id, sort_order, is_active, result_cache) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for tab in &tabs {
        let result_cache = tab
            .result_cache
            .as_ref()
            .map(cache_query_result)
            .map(|result| serde_json::to_string(&result))
            .transpose()?;
        stmt.execute(rusqlite::params![
            tab.id,
            tab.name,
            tab.sql_text,
            tab.project_id,
            tab.sort_order,
            tab.is_active as i64,
            result_cache,
        ])?;
    }
    Ok(())
}

#[cfg(test)]
mod query_tab_tests {
    use super::*;

    #[test]
    fn cached_query_results_are_capped_and_drop_export_table() {
        let result = QueryResult {
            columns: vec!["value".to_string()],
            column_types: vec!["INTEGER".to_string()],
            rows: (0..12)
                .map(|value| vec![serde_json::json!(value)])
                .collect(),
            row_count: 12,
            execution_time_ms: 42,
            export_table_name: Some("__qr_test".to_string()),
        };

        let cached = cache_query_result(&result);

        assert_eq!(cached.rows.len(), MAX_CACHED_QUERY_RESULT_ROWS);
        assert_eq!(cached.row_count, 12);
        assert_eq!(cached.rows[0], vec![serde_json::json!(0)]);
        assert_eq!(cached.rows[9], vec![serde_json::json!(9)]);
        assert_eq!(cached.export_table_name, None);
    }
}
