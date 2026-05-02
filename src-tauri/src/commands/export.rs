use std::path::Path;
use tauri::State;

use crate::db::Database;
use crate::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

#[tauri::command]
pub fn export_results(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    sql: String,
    format: String,
    destination_path: String,
    result_table_name: Option<String>,
) -> Result<String, AppError> {
    let dest = Path::new(&destination_path);

    // Safety: refuse to overwrite existing files
    if dest.exists() {
        return Err(AppError::General(format!(
            "Destination file already exists: {}. Choose a different name to avoid overwriting data.",
            destination_path
        )));
    }

    // Safety: check destination doesn't collide with any registered source
    {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT file_path FROM data_sources")?;
        let paths: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let dest_canonical = std::fs::canonicalize(dest.parent().unwrap_or(Path::new(".")))
            .unwrap_or_else(|_| dest.to_path_buf())
            .join(dest.file_name().unwrap_or_default());

        for source_path in &paths {
            let source_canonical = std::fs::canonicalize(source_path)
                .unwrap_or_else(|_| Path::new(source_path).to_path_buf());
            if dest_canonical == source_canonical {
                return Err(AppError::ExportCollision(source_path.clone()));
            }
        }
    }

    // Prefer the already-materialized result table from query execution. Fall
    // back to SQL for older callers or exports initiated without a result set.
    let export_sql = if let Some(table_name) = result_table_name.as_deref() {
        duckdb.retained_result_table_query(table_name)?
    } else {
        duckdb.wrap_query_for_embedding(&sql)?
    };

    // Build the COPY ... TO ... query
    let escaped_dest = destination_path.replace('\'', "''");
    let copy_sql = match format.as_str() {
        "parquet" => format!(
            "COPY ({}) TO '{}' (FORMAT PARQUET)",
            export_sql, escaped_dest
        ),
        "csv" => format!(
            "COPY ({}) TO '{}' (FORMAT CSV, HEADER)",
            export_sql, escaped_dest
        ),
        _ => {
            return Err(AppError::General(format!(
                "Unsupported export format: {}. Use 'parquet' or 'csv'.",
                format
            )))
        }
    };

    let conn = duckdb.conn.lock().unwrap();
    conn.execute_batch(&copy_sql)?;

    Ok(destination_path)
}
