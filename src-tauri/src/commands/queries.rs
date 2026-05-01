use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

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

fn execute_duckdb_query(
    duckdb: &DuckDbEngine,
    sql: &str,
) -> Result<QueryResult, AppError> {
    // Wrap user SQL with CTEs for all registered data sources.
    let wrapped_sql = duckdb.wrap_query(sql)?;

    let conn = duckdb.conn.lock().unwrap();

    // The duckdb crate's conn.prepare() uses duckdb_extract_statements which
    // has a bug where CTEs + WHERE clauses fail with "Table does not exist".
    // Workaround: use execute_batch (which goes through duckdb_query_arrow and
    // works correctly) to materialize results into a temp table, then read
    // from that table with a trivial SELECT that prepare() can handle.
    let temp_table = format!(
        "__qr_{}",
        uuid::Uuid::new_v4().simple()
    );

    let create_sql = format!(
        "CREATE TEMP TABLE \"{}\" AS {}",
        temp_table, wrapped_sql
    );

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

    // Clean up temp table
    let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\"", temp_table));

    Ok(QueryResult {
        columns,
        column_types,
        row_count: rows.len(),
        rows,
        execution_time_ms: elapsed,
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

#[tauri::command]
pub fn execute_query(
    db: State<Database>,
    duckdb: State<DuckDbEngine>,
    sql: String,
) -> Result<QueryResult, AppError> {
    let result = execute_duckdb_query(&duckdb, &sql);

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
pub fn get_standalone_sql(
    db: State<Database>,
    duckdb: State<DuckDbEngine>,
    sql: String,
) -> Result<String, AppError> {
    // Ensure the in-memory source registry is fully up-to-date from SQLite
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT name, file_path, file_format FROM data_sources")?;
    let sources: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(conn);
    for (name, path, format) in &sources {
        duckdb.register_source(name, path, format)?;
    }
    duckdb.inline_sources(&sql)
}

#[tauri::command]
pub fn clear_query_history(
    db: State<Database>,
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
    db: State<Database>,
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
}

#[tauri::command]
pub fn load_query_tabs(db: State<Database>) -> Result<Vec<SavedQueryTab>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, sql_text, project_id, sort_order, is_active FROM query_tabs ORDER BY sort_order",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SavedQueryTab {
            id: row.get(0)?,
            name: row.get(1)?,
            sql_text: row.get(2)?,
            project_id: row.get(3)?,
            sort_order: row.get(4)?,
            is_active: row.get::<_, i64>(5)? != 0,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn save_query_tabs(
    db: State<Database>,
    tabs: Vec<SavedQueryTab>,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM query_tabs", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO query_tabs (id, name, sql_text, project_id, sort_order, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for tab in &tabs {
        stmt.execute(rusqlite::params![
            tab.id,
            tab.name,
            tab.sql_text,
            tab.project_id,
            tab.sort_order,
            tab.is_active as i64,
        ])?;
    }
    Ok(())
}
