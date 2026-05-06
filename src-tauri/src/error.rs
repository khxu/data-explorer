use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("AI assistant error: {0}")]
    Copilot(#[from] copilot_sdk::CopilotError),

    #[error("{0}")]
    General(String),

    #[error("Export blocked: destination path conflicts with registered source file '{0}'")]
    ExportCollision(String),

    #[error("File not found: {0}")]
    FileNotFound(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
