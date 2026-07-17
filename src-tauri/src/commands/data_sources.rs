use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Database;
use crate::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataSource {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub file_paths: Vec<String>,
    pub file_format: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>, // tag IDs
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataSourceColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataSourceSchema {
    pub data_source_id: String,
    pub name: String,
    pub columns: Vec<DataSourceColumn>,
}

fn detect_format(file_path: &str) -> Option<String> {
    let path = std::path::Path::new(file_path);
    match path.extension().and_then(|e| e.to_str()) {
        Some("parquet") | Some("pq") => Some("parquet".to_string()),
        Some("csv") | Some("tsv") => Some("csv".to_string()),
        Some("json") => Some("json".to_string()),
        Some("jsonl") | Some("ndjson") => Some("ndjson".to_string()),
        _ => None,
    }
}

pub(crate) fn deserialize_file_paths(
    file_path: String,
    file_paths: Option<String>,
) -> Result<Vec<String>, AppError> {
    match file_paths {
        Some(paths) => Ok(serde_json::from_str(&paths)?),
        None => Ok(vec![file_path]),
    }
}

#[tauri::command]
pub fn register_data_source(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    name: String,
    file_paths: Vec<String>,
) -> Result<DataSource, AppError> {
    if file_paths.is_empty() {
        return Err(AppError::General(
            "Select at least one data file.".to_string(),
        ));
    }

    for file_path in &file_paths {
        if !std::path::Path::new(file_path).exists() {
            return Err(AppError::FileNotFound(file_path.clone()));
        }
    }

    let file_format = detect_format(&file_paths[0]).ok_or_else(|| {
        AppError::General(format!(
            "Could not detect format for file: {}. Supported: .parquet, .csv, .tsv, .json, .jsonl, .ndjson",
            file_paths[0]
        ))
    })?;
    if file_paths
        .iter()
        .skip(1)
        .any(|path| detect_format(path).as_deref() != Some(file_format.as_str()))
    {
        return Err(AppError::General(
            "All files in a data source must use the same format.".to_string(),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let file_path = file_paths[0].clone();
    let serialized_file_paths = serde_json::to_string(&file_paths)?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO data_sources (id, name, file_path, file_paths, file_format) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, name, file_path, serialized_file_paths, file_format],
    )?;

    // Register in DuckDB
    duckdb.register_source(&name, &file_paths, &file_format)?;

    Ok(DataSource {
        id,
        name,
        file_path,
        file_paths,
        file_format,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        tags: vec![],
    })
}

#[tauri::command]
pub fn remove_data_source(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    id: String,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    // Get name before deleting so we can unregister the DuckDB view
    let name: String = conn.query_row(
        "SELECT name FROM data_sources WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    )?;
    conn.execute(
        "DELETE FROM data_sources WHERE id = ?1",
        rusqlite::params![id],
    )?;
    drop(conn);
    duckdb.unregister_source(&name)?;
    Ok(())
}

#[tauri::command]
pub fn refresh_data_source(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    id: String,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    let (name, file_path, file_paths, file_format): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT name, file_path, file_paths, file_format FROM data_sources WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    drop(conn);
    let file_paths = deserialize_file_paths(file_path, file_paths)?;
    duckdb.register_source(&name, &file_paths, &file_format)?;
    Ok(())
}

#[tauri::command]
pub fn refresh_all_data_sources(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
) -> Result<(), AppError> {
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
    Ok(())
}

#[tauri::command]
pub fn get_data_source_schema(
    db: State<std::sync::Arc<Database>>,
    duckdb: State<std::sync::Arc<DuckDbEngine>>,
    id: String,
) -> Result<DataSourceSchema, AppError> {
    let conn = db.conn.lock().unwrap();
    let (name, file_path, file_paths, file_format): (String, String, Option<String>, String) = conn
        .query_row(
            "SELECT name, file_path, file_paths, file_format FROM data_sources WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    drop(conn);
    let file_paths = deserialize_file_paths(file_path, file_paths)?;

    let columns = duckdb
        .columns_for_source(&file_paths, &file_format)?
        .into_iter()
        .map(|(name, data_type)| DataSourceColumn { name, data_type })
        .collect();

    Ok(DataSourceSchema {
        data_source_id: id,
        name,
        columns,
    })
}

#[tauri::command]
pub fn list_data_sources(
    db: State<std::sync::Arc<Database>>,
    tag_ids: Option<Vec<String>>,
) -> Result<Vec<DataSource>, AppError> {
    let conn = db.conn.lock().unwrap();

    let mut sources: Vec<DataSource> = if let Some(ref tags) = tag_ids {
        if tags.is_empty() {
            return Ok(vec![]);
        }
        let placeholders: Vec<String> = tags
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "SELECT DISTINCT ds.id, ds.name, ds.file_path, ds.file_paths, ds.file_format, ds.created_at, ds.updated_at
             FROM data_sources ds
             JOIN data_source_tags dst ON ds.id = dst.data_source_id
             WHERE dst.tag_id IN ({})
             ORDER BY ds.name",
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = tags
            .iter()
            .map(|t| t as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok(DataSource {
                id: row.get(0)?,
                name: row.get(1)?,
                file_path: row.get(2)?,
                file_paths: deserialize_file_paths(row.get(2)?, row.get(3)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                file_format: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                tags: vec![],
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, name, file_path, file_paths, file_format, created_at, updated_at FROM data_sources ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DataSource {
                id: row.get(0)?,
                name: row.get(1)?,
                file_path: row.get(2)?,
                file_paths: deserialize_file_paths(row.get(2)?, row.get(3)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                file_format: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                tags: vec![],
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // Populate tags for each source
    for source in &mut sources {
        let mut stmt =
            conn.prepare("SELECT tag_id FROM data_source_tags WHERE data_source_id = ?1")?;
        let tag_rows =
            stmt.query_map(rusqlite::params![source.id], |row| row.get::<_, String>(0))?;
        source.tags = tag_rows.collect::<Result<Vec<_>, _>>()?;
    }

    Ok(sources)
}
