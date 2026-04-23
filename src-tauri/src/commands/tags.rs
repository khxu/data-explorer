use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Database;
use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub fn create_tag(
    db: State<Database>,
    name: String,
    color: Option<String>,
) -> Result<Tag, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, name, color],
    )?;
    Ok(Tag {
        id,
        name,
        color,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn delete_tag(db: State<Database>, id: String) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM tags WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

#[tauri::command]
pub fn list_tags(db: State<Database>) -> Result<Vec<Tag>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name, color, created_at FROM tags ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn assign_tags(
    db: State<Database>,
    data_source_id: String,
    tag_ids: Vec<String>,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    for tag_id in &tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO data_source_tags (data_source_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![data_source_id, tag_id],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_tags(
    db: State<Database>,
    data_source_id: String,
    tag_ids: Vec<String>,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    for tag_id in &tag_ids {
        conn.execute(
            "DELETE FROM data_source_tags WHERE data_source_id = ?1 AND tag_id = ?2",
            rusqlite::params![data_source_id, tag_id],
        )?;
    }
    Ok(())
}
