mod commands;
mod db;
mod duckdb_engine;
mod error;
mod prompt_template;

use std::sync::Arc;
use tauri::Manager;

use db::Database;
use duckdb_engine::DuckDbEngine;

use commands::ai::*;
use commands::data_sources::deserialize_file_paths;
use commands::data_sources::*;
use commands::export::*;
use commands::llm_runs::*;
use commands::openai::*;
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

            {
                let conn = database.conn.lock().unwrap();
                let _ = conn.execute(
                    "UPDATE llm_runs SET status = 'paused', requested_action = NULL WHERE status = 'running'",
                    [],
                );
            }

            // Re-register all existing data sources into DuckDB on startup
            {
                let conn = database.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare("SELECT name, file_path, file_paths, file_format FROM data_sources")
                    .unwrap();
                let sources: Vec<(String, String, Option<String>, String)> = stmt
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })
                    .unwrap()
                    .filter_map(|r| r.ok())
                    .collect();
                drop(stmt);
                drop(conn);
                for (name, path, paths, format) in sources {
                    if let Ok(file_paths) = deserialize_file_paths(path, paths) {
                        let _ = duckdb.register_source(&name, &file_paths, &format);
                    }
                }
            }

            app.manage(Arc::new(database));
            app.manage(Arc::new(duckdb));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_data_source,
            remove_data_source,
            refresh_data_source,
            refresh_all_data_sources,
            get_data_source_schema,
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
            cancel_query,
            release_query_result,
            get_standalone_sql,
            get_query_history,
            clear_query_history,
            load_query_tabs,
            save_query_tabs,
            export_results,
            list_ai_models,
            draft_sql_query,
            get_ai_assist_history,
            clear_ai_assist_history,
            list_llm_experiments,
            save_llm_experiment,
            delete_llm_experiment,
            preview_llm_input,
            export_openai_batch_jsonl,
            get_openai_credential_status,
            set_openai_api_key,
            delete_openai_api_key,
            list_openai_models,
            list_llm_runs,
            get_llm_run_results,
            start_llm_run,
            pause_llm_run,
            cancel_llm_run,
            resume_llm_run,
            retry_failed_llm_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
