mod commands;
mod db;
mod duckdb_engine;
mod error;

use tauri::Manager;

use db::Database;
use duckdb_engine::DuckDbEngine;

use commands::data_sources::*;
use commands::export::*;
use commands::projects::*;
use commands::queries::*;
use commands::tags::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let database = Database::new(app_dir).expect("failed to initialize SQLite database");
            let duckdb = DuckDbEngine::new().expect("failed to initialize DuckDB engine");

            // Re-register all existing data sources into DuckDB on startup
            {
                let conn = database.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare("SELECT name, file_path, file_format FROM data_sources")
                    .unwrap();
                let sources: Vec<(String, String, String)> = stmt
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .unwrap()
                    .filter_map(|r| r.ok())
                    .collect();
                drop(stmt);
                drop(conn);
                for (name, path, format) in &sources {
                    let _ = duckdb.register_source(name, path, format);
                }
            }

            app.manage(database);
            app.manage(duckdb);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_data_source,
            remove_data_source,
            refresh_data_source,
            refresh_all_data_sources,
            list_data_sources,
            create_tag,
            delete_tag,
            list_tags,
            assign_tags,
            remove_tags,
            create_project,
            update_project,
            delete_project,
            list_projects,
            execute_query,
            get_query_history,
            clear_query_history,
            load_query_tabs,
            save_query_tabs,
            export_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
