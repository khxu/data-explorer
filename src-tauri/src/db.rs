use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::AppError;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: PathBuf) -> Result<Self, AppError> {
        std::fs::create_dir_all(&app_dir)?;
        let db_path = app_dir.join("data_explorer.db");
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS data_sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                file_path TEXT NOT NULL UNIQUE,
                file_format TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS data_source_tags (
                data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (data_source_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                tag_filter TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS query_history (
                id TEXT PRIMARY KEY,
                sql_text TEXT NOT NULL,
                status TEXT NOT NULL,
                error_message TEXT,
                row_count INTEGER,
                execution_time_ms INTEGER,
                result_sample TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS ai_assist_history (
                id TEXT PRIMARY KEY,
                prompt_text TEXT NOT NULL,
                generated_sql TEXT NOT NULL,
                requested_model TEXT,
                model_used TEXT,
                model_name TEXT,
                token_usage TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS query_tabs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sql_text TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS llm_experiments (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                input_source_type TEXT NOT NULL,
                data_source_id TEXT REFERENCES data_sources(id) ON DELETE SET NULL,
                sql_text TEXT,
                selected_columns TEXT NOT NULL DEFAULT '[]',
                system_prompt TEXT NOT NULL DEFAULT '',
                user_prompt TEXT NOT NULL DEFAULT '',
                models TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS llm_runs (
                id TEXT PRIMARY KEY,
                experiment_id TEXT NOT NULL REFERENCES llm_experiments(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                total_count INTEGER NOT NULL DEFAULT 0,
                completed_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                requested_action TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS llm_run_results (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
                experiment_id TEXT NOT NULL REFERENCES llm_experiments(id) ON DELETE CASCADE,
                row_index INTEGER NOT NULL,
                model TEXT NOT NULL,
                status TEXT NOT NULL,
                source_row TEXT NOT NULL,
                input_system TEXT,
                input_user TEXT,
                output TEXT,
                error TEXT,
                token_usage TEXT,
                latency_ms INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(run_id, row_index, model)
            );

            CREATE TABLE IF NOT EXISTS llm_logs (
                id TEXT PRIMARY KEY,
                run_id TEXT REFERENCES llm_runs(id) ON DELETE CASCADE,
                experiment_id TEXT REFERENCES llm_experiments(id) ON DELETE CASCADE,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            ",
        )?;

        let has_query_tab_project_id = conn
            .prepare("PRAGMA table_info(query_tabs)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|column| column == "project_id");

        if !has_query_tab_project_id {
            conn.execute(
                "ALTER TABLE query_tabs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
                [],
            )?;
        }

        let has_query_tab_result_cache = conn
            .prepare("PRAGMA table_info(query_tabs)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|column| column == "result_cache");

        if !has_query_tab_result_cache {
            conn.execute("ALTER TABLE query_tabs ADD COLUMN result_cache TEXT", [])?;
        }

        Ok(())
    }
}
