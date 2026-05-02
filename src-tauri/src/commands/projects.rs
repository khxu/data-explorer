use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Database;
use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tag_filter: Vec<String>, // tag IDs
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn create_project(
    db: State<std::sync::Arc<Database>>,
    name: String,
    description: Option<String>,
    tag_filter: Vec<String>,
) -> Result<Project, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let tag_json = serde_json::to_string(&tag_filter)?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO projects (id, name, description, tag_filter) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, description, tag_json],
    )?;
    Ok(Project {
        id,
        name,
        description,
        tag_filter,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn update_project(
    db: State<std::sync::Arc<Database>>,
    id: String,
    name: String,
    description: Option<String>,
    tag_filter: Vec<String>,
) -> Result<(), AppError> {
    let tag_json = serde_json::to_string(&tag_filter)?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE projects SET name = ?1, description = ?2, tag_filter = ?3, updated_at = datetime('now') WHERE id = ?4",
        rusqlite::params![name, description, tag_json, id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn delete_project(db: State<std::sync::Arc<Database>>, id: String) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM projects WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_projects(db: State<std::sync::Arc<Database>>) -> Result<Vec<Project>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, name, description, tag_filter, created_at, updated_at FROM projects ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        let tag_json: String = row.get(3)?;
        let tag_filter: Vec<String> =
            serde_json::from_str(&tag_json).unwrap_or_default();
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            tag_filter,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
