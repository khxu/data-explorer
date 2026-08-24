use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use copilot_sdk::{
    session_events::{
        AssistantMessageData, AssistantMessageDeltaData, AssistantUsageData, SessionErrorData,
        SessionModelChangeData, SessionStartData,
    },
    Client, ClientOptions, SessionConfig, SystemMessageConfig,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::ai::AiTokenUsage;
use crate::commands::data_sources::deserialize_file_paths;
use crate::commands::export::validate_export_destination;
use crate::db::Database;
use crate::duckdb_engine::{DuckDbEngine, SourcePreview};
use crate::error::AppError;
use crate::prompt_template;

const LLM_ROW_TIMEOUT: Duration = Duration::from_secs(120);
const OPENAI_BATCH_MAX_REQUESTS: usize = 50_000;
const OPENAI_BATCH_MAX_BYTES: u64 = 200 * 1024 * 1024;
const EMPTY_USER_PROMPT_FALLBACK: &str = "Process this row according to the system prompt.";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmExperiment {
    pub id: String,
    pub name: String,
    pub input_source_type: String,
    pub data_source_id: Option<String>,
    pub sql_text: Option<String>,
    pub selected_columns: Vec<String>,
    pub system_prompt: String,
    pub user_prompt: String,
    pub models: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmExperimentDraft {
    pub id: Option<String>,
    pub name: String,
    pub input_source_type: String,
    pub data_source_id: Option<String>,
    pub sql_text: Option<String>,
    pub selected_columns: Vec<String>,
    pub system_prompt: String,
    pub user_prompt: String,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmRun {
    pub id: String,
    pub experiment_id: String,
    pub experiment_name: String,
    pub status: String,
    pub total_count: i64,
    pub completed_count: i64,
    pub failed_count: i64,
    pub requested_action: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmRunResult {
    pub id: String,
    pub run_id: String,
    pub experiment_id: String,
    pub row_index: i64,
    pub model: String,
    pub status: String,
    pub source_row: String,
    pub input_system: Option<String>,
    pub input_user: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub token_usage: Option<String>,
    pub latency_ms: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmInputPreview {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LlmRunProgress {
    pub run_id: String,
    pub experiment_id: String,
    pub kind: String,
    pub status: String,
    pub row_index: Option<i64>,
    pub model: Option<String>,
    pub completed_count: i64,
    pub failed_count: i64,
    pub total_count: i64,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
struct InputRow {
    row_index: i64,
    data: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum OpenAiBatchEndpoint {
    Responses,
    ChatCompletions,
}

impl OpenAiBatchEndpoint {
    fn url(self) -> &'static str {
        match self {
            Self::Responses => "/v1/responses",
            Self::ChatCompletions => "/v1/chat/completions",
        }
    }
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiBatchOptions {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub advanced: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct OpenAiBatchExportFile {
    pub destination_path: String,
    pub request_count: usize,
    pub byte_count: u64,
}

#[derive(Debug, Serialize)]
pub struct OpenAiBatchExportResult {
    pub files: Vec<OpenAiBatchExportFile>,
    pub request_count: usize,
    pub byte_count: u64,
}

#[derive(Debug, Serialize)]
struct OpenAiBatchRequest {
    custom_id: String,
    method: &'static str,
    url: &'static str,
    body: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenAiBatchChunk {
    start: usize,
    end: usize,
    byte_count: u64,
}

#[tauri::command]
pub fn list_llm_experiments(db: State<'_, Arc<Database>>) -> Result<Vec<LlmExperiment>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, input_source_type, data_source_id, sql_text, selected_columns,
                system_prompt, user_prompt, models, created_at, updated_at
         FROM llm_experiments ORDER BY updated_at DESC, created_at DESC",
    )?;
    let rows = stmt.query_map([], parse_experiment_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn save_llm_experiment(
    db: State<'_, Arc<Database>>,
    draft: LlmExperimentDraft,
) -> Result<LlmExperiment, AppError> {
    validate_experiment_draft(&draft)?;
    let id = draft.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let selected_columns = serde_json::to_string(&draft.selected_columns)?;
    let models = serde_json::to_string(&draft.models)?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO llm_experiments
            (id, name, input_source_type, data_source_id, sql_text, selected_columns, system_prompt, user_prompt, models)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            input_source_type = excluded.input_source_type,
            data_source_id = excluded.data_source_id,
            sql_text = excluded.sql_text,
            selected_columns = excluded.selected_columns,
            system_prompt = excluded.system_prompt,
            user_prompt = excluded.user_prompt,
            models = excluded.models,
            updated_at = datetime('now')",
        rusqlite::params![
            id,
            draft.name.trim(),
            draft.input_source_type,
            draft.data_source_id,
            draft.sql_text,
            selected_columns,
            draft.system_prompt,
            draft.user_prompt,
            models
        ],
    )?;
    load_experiment(&conn, &id)
}

#[tauri::command]
pub fn delete_llm_experiment(db: State<'_, Arc<Database>>, id: String) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM llm_experiments WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn preview_llm_input(
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    input_source_type: String,
    data_source_id: Option<String>,
    sql_text: Option<String>,
    selected_columns: Vec<String>,
    limit: Option<usize>,
) -> Result<LlmInputPreview, AppError> {
    let preview = materialize_preview(
        db.inner(),
        duckdb.inner(),
        &input_source_type,
        data_source_id.as_deref(),
        sql_text.as_deref(),
        limit.or(Some(25)),
    )?;
    let preview = filter_preview_columns(preview, &selected_columns)?;
    Ok(LlmInputPreview {
        columns: preview
            .columns
            .iter()
            .map(|(name, _)| name.clone())
            .collect(),
        column_types: preview
            .columns
            .iter()
            .map(|(_, data_type)| data_type.clone())
            .collect(),
        rows: preview.rows,
    })
}

#[tauri::command]
pub fn export_openai_batch_jsonl(
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    draft: LlmExperimentDraft,
    model: String,
    endpoint: OpenAiBatchEndpoint,
    options: OpenAiBatchOptions,
    destination_path: String,
) -> Result<OpenAiBatchExportResult, AppError> {
    validate_batch_export_draft(&draft, &model)?;
    validate_openai_batch_options(&options)?;
    let experiment = draft_to_materialization_experiment(draft);
    let rows = materialize_input_rows(db.inner(), duckdb.inner(), &experiment, None)?;
    if rows.is_empty() {
        return Err(AppError::General(
            "The selected input has no rows.".to_string(),
        ));
    }
    validate_prompt_placeholders_against_columns(
        &experiment.system_prompt,
        &experiment.user_prompt,
        rows[0].data.keys().map(String::as_str),
    )?;

    let chunks = plan_openai_batch_chunks(
        &rows,
        model.trim(),
        endpoint,
        &experiment.system_prompt,
        &experiment.user_prompt,
        &options,
        OPENAI_BATCH_MAX_REQUESTS,
        OPENAI_BATCH_MAX_BYTES,
    )?;
    let destination_paths = split_destination_paths(&destination_path, chunks.len())?;
    for path in &destination_paths {
        validate_export_destination(db.inner(), &path.to_string_lossy())?;
    }
    let files = write_openai_batch_parts(
        &destination_paths,
        &chunks,
        &rows,
        model.trim(),
        endpoint,
        &experiment.system_prompt,
        &experiment.user_prompt,
        &options,
    )?;

    Ok(OpenAiBatchExportResult {
        request_count: files.iter().map(|file| file.request_count).sum(),
        byte_count: files.iter().map(|file| file.byte_count).sum(),
        files,
    })
}

#[tauri::command]
pub fn list_llm_runs(db: State<'_, Arc<Database>>) -> Result<Vec<LlmRun>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.experiment_id, e.name, r.status, r.total_count, r.completed_count,
                r.failed_count, r.requested_action, r.started_at, r.completed_at
         FROM llm_runs r
         JOIN llm_experiments e ON e.id = r.experiment_id
         ORDER BY r.started_at DESC
         LIMIT 100",
    )?;
    let rows = stmt.query_map([], parse_run_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn get_llm_run_results(
    db: State<'_, Arc<Database>>,
    run_id: String,
) -> Result<Vec<LlmRunResult>, AppError> {
    let conn = db.conn.lock().unwrap();
    list_run_results(&conn, &run_id)
}

#[tauri::command]
pub async fn start_llm_run(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    experiment_id: String,
) -> Result<LlmRun, AppError> {
    let run_id = uuid::Uuid::new_v4().to_string();
    execute_run(
        app,
        db.inner().clone(),
        duckdb.inner().clone(),
        experiment_id,
        run_id,
        false,
    )
    .await
}

#[tauri::command]
pub fn pause_llm_run(db: State<'_, Arc<Database>>, run_id: String) -> Result<(), AppError> {
    request_run_action(db.inner(), &run_id, "pause")
}

#[tauri::command]
pub fn cancel_llm_run(db: State<'_, Arc<Database>>, run_id: String) -> Result<(), AppError> {
    request_run_action(db.inner(), &run_id, "cancel")
}

#[tauri::command]
pub async fn resume_llm_run(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    run_id: String,
) -> Result<LlmRun, AppError> {
    let experiment_id = run_experiment_id(db.inner(), &run_id)?;
    execute_run(
        app,
        db.inner().clone(),
        duckdb.inner().clone(),
        experiment_id,
        run_id,
        false,
    )
    .await
}

#[tauri::command]
pub async fn retry_failed_llm_run(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    run_id: String,
) -> Result<LlmRun, AppError> {
    let experiment_id = run_experiment_id(db.inner(), &run_id)?;
    execute_run(
        app,
        db.inner().clone(),
        duckdb.inner().clone(),
        experiment_id,
        run_id,
        true,
    )
    .await
}

async fn execute_run(
    app: AppHandle,
    db: Arc<Database>,
    duckdb: Arc<DuckDbEngine>,
    experiment_id: String,
    run_id: String,
    retry_failed: bool,
) -> Result<LlmRun, AppError> {
    let experiment = {
        let conn = db.conn.lock().unwrap();
        load_experiment(&conn, &experiment_id)?
    };
    if experiment.models.is_empty() {
        return Err(AppError::General(
            "Select at least one Copilot model.".to_string(),
        ));
    }
    if experiment.user_prompt.trim().is_empty() && experiment.system_prompt.trim().is_empty() {
        return Err(AppError::General(
            "Add a system or user prompt before starting an LLM run.".to_string(),
        ));
    }

    let rows = materialize_input_rows(&db, &duckdb, &experiment, None)?;
    if rows.is_empty() {
        return Err(AppError::General(
            "The selected input has no rows.".to_string(),
        ));
    }
    let total_count = (rows.len() * experiment.models.len()) as i64;
    initialize_run(&db, &run_id, &experiment.id, total_count, retry_failed)?;
    emit_progress(
        &app,
        &run_id,
        &experiment.id,
        "status",
        "running",
        None,
        None,
        "Starting Copilot row processing.",
    );

    let client = Client::start(ClientOptions::default()).await?;
    let result =
        execute_run_with_client(&app, &db, &client, &experiment, &run_id, rows, retry_failed).await;
    let stop_result = client
        .stop()
        .await
        .map_err(|err| AppError::General(format!("Failed to stop Copilot client: {err}")));
    match (result, stop_result) {
        (Err(err), _) => Err(err),
        (Ok(_), Err(err)) => Err(err),
        (Ok(()), Ok(())) => {
            let conn = db.conn.lock().unwrap();
            load_run(&conn, &run_id)
        }
    }
}

async fn execute_run_with_client(
    app: &AppHandle,
    db: &Database,
    client: &Client,
    experiment: &LlmExperiment,
    run_id: &str,
    rows: Vec<InputRow>,
    retry_failed: bool,
) -> Result<(), AppError> {
    for row in rows {
        for model in &experiment.models {
            if handle_requested_action(app, db, run_id, &experiment.id)? {
                return Ok(());
            }

            let existing = existing_result(db, run_id, row.row_index, model)?;
            if should_skip_existing(existing.as_ref(), retry_failed) {
                continue;
            }

            let rendered_system =
                prompt_template::interpolate(&experiment.system_prompt, &row.data);
            let rendered_user = prompt_template::interpolate(&experiment.user_prompt, &row.data);
            let result_id = upsert_running_result(
                db,
                existing.as_ref().map(|(id, _)| id.as_str()),
                run_id,
                &experiment.id,
                row.row_index,
                model,
                &row.data,
                &rendered_system,
                &rendered_user,
            )?;
            update_run_status_counts(db, run_id, "running", None)?;
            emit_progress(
                app,
                run_id,
                &experiment.id,
                "status",
                "running",
                Some(row.row_index),
                Some(model),
                "Sending row to Copilot.",
            );

            let start = Instant::now();
            let response =
                run_copilot_prompt(client, model, &rendered_system, &rendered_user).await;
            let latency_ms = start.elapsed().as_millis() as i64;
            match response {
                Ok((output, usage)) => {
                    update_result_success(db, &result_id, &output, usage.as_ref(), latency_ms)?
                }
                Err(err) => update_result_error(db, &result_id, &err.to_string(), latency_ms)?,
            }
            update_run_status_counts(db, run_id, "running", None)?;
            let run = {
                let conn = db.conn.lock().unwrap();
                load_run(&conn, run_id)?
            };
            emit_progress_with_counts(
                app,
                run_id,
                &experiment.id,
                "result",
                &run.status,
                Some(row.row_index),
                Some(model),
                run.completed_count,
                run.failed_count,
                run.total_count,
                "Row/model result saved.",
            );
        }
    }

    update_run_status_counts(db, run_id, "completed", Some("datetime('now')"))?;
    emit_progress(
        app,
        run_id,
        &experiment.id,
        "done",
        "completed",
        None,
        None,
        "LLM run completed.",
    );
    Ok(())
}

async fn run_copilot_prompt(
    client: &Client,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<(String, Option<AiTokenUsage>), AppError> {
    let system_content = if system_prompt.trim().is_empty() {
        "You process one data row at a time. Return only the requested answer for the row."
            .to_string()
    } else {
        system_prompt.to_string()
    };
    let mut config = SessionConfig::default()
        .with_streaming(true)
        .with_available_tools(Vec::<String>::new())
        .with_excluded_tools(["shell", "write", "edit", "read", "grep", "glob"])
        .deny_all_permissions()
        .with_client_name("data-explorer-llm-runs")
        .with_system_message(
            SystemMessageConfig::new()
                .with_mode("replace")
                .with_content(system_content),
        );
    config.model = Some(model.to_string());
    let session = client.create_session(config).await?;
    let mut events = session.subscribe();
    let prompt = if user_prompt.trim().is_empty() {
        EMPTY_USER_PROMPT_FALLBACK.to_string()
    } else {
        user_prompt.to_string()
    };
    session.send(prompt).await?;

    let mut content = String::new();
    let mut saw_delta = false;
    let mut token_usage = None;
    tokio::time::timeout(LLM_ROW_TIMEOUT, async {
        loop {
            match events.recv().await {
                Ok(event) => match event.event_type.as_str() {
                    "assistant.message_delta" => {
                        let delta: AssistantMessageDeltaData =
                            serde_json::from_value(event.data.clone())?;
                        saw_delta = true;
                        content.push_str(&delta.delta_content);
                    }
                    "assistant.message" => {
                        let message: AssistantMessageData =
                            serde_json::from_value(event.data.clone())?;
                        if !saw_delta {
                            content.push_str(&message.content);
                        }
                    }
                    "assistant.usage" => {
                        let usage: AssistantUsageData = serde_json::from_value(event.data.clone())?;
                        token_usage = Some(AiTokenUsage {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            cache_read_tokens: usage.cache_read_tokens,
                            cache_write_tokens: usage.cache_write_tokens,
                            total_tokens: total_tokens(
                                usage.input_tokens,
                                usage.output_tokens,
                                usage.cache_read_tokens,
                                usage.cache_write_tokens,
                            ),
                            duration_ms: usage.duration,
                        });
                    }
                    "session.start" => {
                        let _: SessionStartData = serde_json::from_value(event.data.clone())?;
                    }
                    "session.model_change" => {
                        let _: SessionModelChangeData = serde_json::from_value(event.data.clone())?;
                    }
                    "session.idle" => break,
                    "session.error" => {
                        let err: SessionErrorData = serde_json::from_value(event.data.clone())?;
                        return Err(AppError::General(format!(
                            "Copilot session error: {}",
                            err.message
                        )));
                    }
                    _ => {}
                },
                Err(err) => {
                    return Err(AppError::General(format!(
                        "Copilot event stream closed: {}",
                        err
                    )));
                }
            }
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|_| AppError::General("Copilot timed out while processing a row.".to_string()))??;

    Ok((content.trim().to_string(), token_usage))
}

fn materialize_input_rows(
    db: &Database,
    duckdb: &DuckDbEngine,
    experiment: &LlmExperiment,
    limit: Option<usize>,
) -> Result<Vec<InputRow>, AppError> {
    let preview = materialize_preview(
        db,
        duckdb,
        &experiment.input_source_type,
        experiment.data_source_id.as_deref(),
        experiment.sql_text.as_deref(),
        limit,
    )?;
    let preview = filter_preview_columns(preview, &experiment.selected_columns)?;
    let columns: Vec<String> = preview.columns.into_iter().map(|(name, _)| name).collect();
    Ok(preview
        .rows
        .into_iter()
        .enumerate()
        .map(|(index, values)| InputRow {
            row_index: index as i64,
            data: columns
                .iter()
                .cloned()
                .zip(values)
                .collect::<serde_json::Map<_, _>>(),
        })
        .collect())
}

fn materialize_preview(
    db: &Database,
    duckdb: &DuckDbEngine,
    input_source_type: &str,
    data_source_id: Option<&str>,
    sql_text: Option<&str>,
    limit: Option<usize>,
) -> Result<SourcePreview, AppError> {
    match input_source_type {
        "data_source" => {
            let id = data_source_id.ok_or_else(|| {
                AppError::General("Choose a data source for this LLM experiment.".to_string())
            })?;
            let conn = db.conn.lock().unwrap();
            let (file_path, file_paths, file_format): (String, Option<String>, String) = conn
                .query_row(
                    "SELECT file_path, file_paths, file_format FROM data_sources WHERE id = ?1",
                    rusqlite::params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            drop(conn);
            let file_paths = deserialize_file_paths(file_path, file_paths)?;
            duckdb.source_rows(&file_paths, &file_format, limit)
        }
        "sql" => {
            let sql = sql_text
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    AppError::General("Enter SQL for this LLM experiment.".to_string())
                })?;
            duckdb.query_rows(sql, limit)
        }
        other => Err(AppError::General(format!(
            "Unsupported LLM input source type: {}",
            other
        ))),
    }
}

fn filter_preview_columns(
    preview: SourcePreview,
    selected_columns: &[String],
) -> Result<SourcePreview, AppError> {
    if selected_columns.is_empty() {
        return Ok(preview);
    }
    let indexes: Vec<usize> = selected_columns
        .iter()
        .map(|column| {
            preview
                .columns
                .iter()
                .position(|(name, _)| name == column)
                .ok_or_else(|| AppError::General(format!("Unknown selected column: {}", column)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let columns = indexes
        .iter()
        .map(|index| preview.columns[*index].clone())
        .collect();
    let rows = preview
        .rows
        .into_iter()
        .map(|row| indexes.iter().map(|index| row[*index].clone()).collect())
        .collect();
    Ok(SourcePreview { columns, rows })
}

fn draft_to_materialization_experiment(draft: LlmExperimentDraft) -> LlmExperiment {
    LlmExperiment {
        id: draft.id.unwrap_or_default(),
        name: draft.name,
        input_source_type: draft.input_source_type,
        data_source_id: draft.data_source_id,
        sql_text: draft.sql_text,
        selected_columns: draft.selected_columns,
        system_prompt: draft.system_prompt,
        user_prompt: draft.user_prompt,
        models: draft.models,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn validate_batch_export_draft(draft: &LlmExperimentDraft, model: &str) -> Result<(), AppError> {
    if model.trim().is_empty() {
        return Err(AppError::General(
            "Enter an OpenAI model ID for the Batch export.".to_string(),
        ));
    }
    validate_prompts_and_placeholders(draft)
}

fn validate_openai_batch_options(options: &OpenAiBatchOptions) -> Result<(), AppError> {
    if let Some(temperature) = options.temperature {
        if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
            return Err(AppError::General(
                "Temperature must be between 0 and 2.".to_string(),
            ));
        }
    }
    if let Some(top_p) = options.top_p {
        if !top_p.is_finite() || !(0.0..=1.0).contains(&top_p) {
            return Err(AppError::General(
                "Top-p must be between 0 and 1.".to_string(),
            ));
        }
    }
    if options.max_output_tokens == Some(0) {
        return Err(AppError::General(
            "Maximum output tokens must be greater than zero.".to_string(),
        ));
    }

    const RESERVED_KEYS: &[&str] = &[
        "model",
        "input",
        "instructions",
        "messages",
        "stream",
        "temperature",
        "top_p",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
    ];
    if let Some(key) = options
        .advanced
        .keys()
        .find(|key| RESERVED_KEYS.contains(&key.as_str()))
    {
        return Err(AppError::General(format!(
            "Advanced JSON cannot set reserved field '{key}'."
        )));
    }

    Ok(())
}

fn validate_experiment_draft(draft: &LlmExperimentDraft) -> Result<(), AppError> {
    if draft.name.trim().is_empty() {
        return Err(AppError::General("Name the LLM experiment.".to_string()));
    }
    if draft.models.is_empty() {
        return Err(AppError::General(
            "Select at least one Copilot model.".to_string(),
        ));
    }
    validate_prompts_and_placeholders(draft)
}

fn validate_prompts_and_placeholders(draft: &LlmExperimentDraft) -> Result<(), AppError> {
    if draft.system_prompt.trim().is_empty() && draft.user_prompt.trim().is_empty() {
        return Err(AppError::General(
            "Add a system or user prompt before continuing.".to_string(),
        ));
    }
    if !draft.selected_columns.is_empty() {
        validate_prompt_placeholders_against_columns(
            &draft.system_prompt,
            &draft.user_prompt,
            draft.selected_columns.iter().map(String::as_str),
        )?;
    }
    Ok(())
}

fn validate_prompt_placeholders_against_columns<'a>(
    system_prompt: &str,
    user_prompt: &str,
    columns: impl IntoIterator<Item = &'a str>,
) -> Result<(), AppError> {
    let available = columns
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    for placeholder in prompt_template::extract_placeholders(system_prompt)
        .into_iter()
        .chain(prompt_template::extract_placeholders(user_prompt))
    {
        if !available.contains(placeholder.as_str()) {
            return Err(AppError::General(format!(
                "Prompt references a column that is not selected: {}",
                placeholder
            )));
        }
    }
    Ok(())
}

fn build_openai_batch_request(
    row: &InputRow,
    model: &str,
    endpoint: OpenAiBatchEndpoint,
    system_prompt: &str,
    user_prompt: &str,
    options: &OpenAiBatchOptions,
) -> OpenAiBatchRequest {
    let rendered_system = prompt_template::interpolate(system_prompt, &row.data);
    let rendered_user = prompt_template::interpolate(user_prompt, &row.data);
    let input = if rendered_user.trim().is_empty() {
        EMPTY_USER_PROMPT_FALLBACK
    } else {
        rendered_user.as_str()
    };

    let mut body = match endpoint {
        OpenAiBatchEndpoint::Responses => {
            let mut body = serde_json::Map::new();
            body.insert("model".to_string(), serde_json::json!(model));
            if !rendered_system.trim().is_empty() {
                body.insert(
                    "instructions".to_string(),
                    serde_json::json!(rendered_system),
                );
            }
            body.insert("input".to_string(), serde_json::json!(input));
            serde_json::Value::Object(body)
        }
        OpenAiBatchEndpoint::ChatCompletions => {
            let mut messages = Vec::new();
            if !rendered_system.trim().is_empty() {
                messages.push(serde_json::json!({
                    "role": "system",
                    "content": rendered_system,
                }));
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": input,
            }));
            serde_json::json!({
                "model": model,
                "messages": messages,
            })
        }
    };
    let body_object = body
        .as_object_mut()
        .expect("OpenAI Batch request bodies are always JSON objects");
    body_object.extend(options.advanced.clone());
    if let Some(temperature) = options.temperature {
        body_object.insert("temperature".to_string(), serde_json::json!(temperature));
    }
    if let Some(top_p) = options.top_p {
        body_object.insert("top_p".to_string(), serde_json::json!(top_p));
    }
    if let Some(max_output_tokens) = options.max_output_tokens {
        let key = match endpoint {
            OpenAiBatchEndpoint::Responses => "max_output_tokens",
            OpenAiBatchEndpoint::ChatCompletions => "max_completion_tokens",
        };
        body_object.insert(key.to_string(), serde_json::json!(max_output_tokens));
    }

    OpenAiBatchRequest {
        custom_id: format!("row-{}", row.row_index),
        method: "POST",
        url: endpoint.url(),
        body,
    }
}

fn plan_openai_batch_chunks(
    rows: &[InputRow],
    model: &str,
    endpoint: OpenAiBatchEndpoint,
    system_prompt: &str,
    user_prompt: &str,
    options: &OpenAiBatchOptions,
    max_requests: usize,
    max_bytes: u64,
) -> Result<Vec<OpenAiBatchChunk>, AppError> {
    let request_sizes = rows
        .iter()
        .map(|row| {
            let request = build_openai_batch_request(
                row,
                model,
                endpoint,
                system_prompt,
                user_prompt,
                options,
            );
            let line_size = serde_json::to_vec(&request)?.len() as u64 + 1;
            Ok((row.row_index, line_size))
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    plan_openai_batch_chunk_sizes(&request_sizes, max_requests, max_bytes)
}

fn plan_openai_batch_chunk_sizes(
    request_sizes: &[(i64, u64)],
    max_requests: usize,
    max_bytes: u64,
) -> Result<Vec<OpenAiBatchChunk>, AppError> {
    if max_requests == 0 || max_bytes == 0 {
        return Err(AppError::General(
            "OpenAI Batch chunk limits must be greater than zero.".to_string(),
        ));
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    let mut byte_count = 0_u64;

    for (index, (row_index, line_size)) in request_sizes.iter().copied().enumerate() {
        if line_size > max_bytes {
            return Err(AppError::General(format!(
                "The request for row {row_index} exceeds OpenAI's 200 MB Batch input file limit."
            )));
        }

        let request_count = index - start;
        if request_count == max_requests || byte_count + line_size > max_bytes {
            chunks.push(OpenAiBatchChunk {
                start,
                end: index,
                byte_count,
            });
            start = index;
            byte_count = 0;
        }
        byte_count += line_size;
    }

    if start < request_sizes.len() {
        chunks.push(OpenAiBatchChunk {
            start,
            end: request_sizes.len(),
            byte_count,
        });
    }

    Ok(chunks)
}

fn split_destination_paths(
    destination_path: &str,
    part_count: usize,
) -> Result<Vec<PathBuf>, AppError> {
    if part_count == 0 {
        return Err(AppError::General(
            "Cannot create an OpenAI Batch export with no parts.".to_string(),
        ));
    }
    let destination = Path::new(destination_path);
    if destination.file_name().is_none() {
        return Err(AppError::General(
            "Choose a filename for the OpenAI Batch export.".to_string(),
        ));
    }
    if part_count == 1 {
        return Ok(vec![destination.to_path_buf()]);
    }

    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::General("Choose a valid export filename.".to_string()))?;
    let extension = destination.extension().and_then(|value| value.to_str());
    let width = 4.max(part_count.to_string().len());
    Ok((1..=part_count)
        .map(|part| {
            let suffix = format!(
                "{stem}-part-{part:0width$}-of-{part_count:0width$}",
                width = width
            );
            let filename = match extension {
                Some(extension) => format!("{suffix}.{extension}"),
                None => suffix,
            };
            destination.with_file_name(filename)
        })
        .collect())
}

fn write_openai_batch_parts(
    destination_paths: &[PathBuf],
    chunks: &[OpenAiBatchChunk],
    rows: &[InputRow],
    model: &str,
    endpoint: OpenAiBatchEndpoint,
    system_prompt: &str,
    user_prompt: &str,
    options: &OpenAiBatchOptions,
) -> Result<Vec<OpenAiBatchExportFile>, AppError> {
    if destination_paths.len() != chunks.len() {
        return Err(AppError::General(
            "OpenAI Batch export paths do not match the planned parts.".to_string(),
        ));
    }

    let mut created_paths = Vec::new();
    let write_result = destination_paths
        .iter()
        .zip(chunks)
        .map(|(path, chunk)| {
            let file = OpenOptions::new().write(true).create_new(true).open(path)?;
            created_paths.push(path.clone());
            let (request_count, byte_count) = write_openai_batch_jsonl(
                BufWriter::new(file),
                &rows[chunk.start..chunk.end],
                model,
                endpoint,
                system_prompt,
                user_prompt,
                options,
            )?;
            if request_count != chunk.end - chunk.start || byte_count != chunk.byte_count {
                return Err(AppError::General(format!(
                    "OpenAI Batch part changed between planning and writing: {}",
                    path.display()
                )));
            }
            Ok(OpenAiBatchExportFile {
                destination_path: path.to_string_lossy().into_owned(),
                request_count,
                byte_count,
            })
        })
        .collect::<Result<Vec<_>, AppError>>();

    match write_result {
        Ok(files) => Ok(files),
        Err(error) => {
            for path in created_paths {
                let _ = std::fs::remove_file(path);
            }
            Err(error)
        }
    }
}

fn write_openai_batch_jsonl<W: Write>(
    writer: W,
    rows: &[InputRow],
    model: &str,
    endpoint: OpenAiBatchEndpoint,
    system_prompt: &str,
    user_prompt: &str,
    options: &OpenAiBatchOptions,
) -> Result<(usize, u64), AppError> {
    let mut writer = writer;
    let mut byte_count = 0_u64;

    for row in rows {
        let request =
            build_openai_batch_request(row, model, endpoint, system_prompt, user_prompt, options);
        let line = serde_json::to_vec(&request)?;
        writer.write_all(&line)?;
        writer.write_all(b"\n")?;
        byte_count += line.len() as u64 + 1;
    }
    writer.flush()?;

    Ok((rows.len(), byte_count))
}

fn initialize_run(
    db: &Database,
    run_id: &str,
    experiment_id: &str,
    total_count: i64,
    retry_failed: bool,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    if retry_failed {
        conn.execute(
            "UPDATE llm_runs SET status = 'running', requested_action = NULL, total_count = ?2, completed_at = NULL WHERE id = ?1",
            rusqlite::params![run_id, total_count],
        )?;
    } else {
        conn.execute(
            "INSERT INTO llm_runs (id, experiment_id, status, total_count)
             VALUES (?1, ?2, 'running', ?3)
             ON CONFLICT(id) DO UPDATE SET status = 'running', requested_action = NULL, total_count = ?3, completed_at = NULL",
            rusqlite::params![run_id, experiment_id, total_count],
        )?;
    }
    Ok(())
}

fn request_run_action(db: &Database, run_id: &str, action: &str) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE llm_runs SET requested_action = ?2 WHERE id = ?1 AND status = 'running'",
        rusqlite::params![run_id, action],
    )?;
    Ok(())
}

fn handle_requested_action(
    app: &AppHandle,
    db: &Database,
    run_id: &str,
    experiment_id: &str,
) -> Result<bool, AppError> {
    let action = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT requested_action FROM llm_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )?
    };
    match action.as_deref() {
        Some("pause") => {
            update_run_status_counts(db, run_id, "paused", None)?;
            emit_progress(
                app,
                run_id,
                experiment_id,
                "paused",
                "paused",
                None,
                None,
                "LLM run paused.",
            );
            Ok(true)
        }
        Some("cancel") => {
            update_run_status_counts(db, run_id, "canceled", Some("datetime('now')"))?;
            emit_progress(
                app,
                run_id,
                experiment_id,
                "canceled",
                "canceled",
                None,
                None,
                "LLM run canceled.",
            );
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn existing_result(
    db: &Database,
    run_id: &str,
    row_index: i64,
    model: &str,
) -> Result<Option<(String, String)>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, status FROM llm_run_results WHERE run_id = ?1 AND row_index = ?2 AND model = ?3",
    )?;
    let mut rows = stmt.query(rusqlite::params![run_id, row_index, model])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?)))
    } else {
        Ok(None)
    }
}

fn should_skip_existing(existing: Option<&(String, String)>, retry_failed: bool) -> bool {
    match existing.map(|(_, status)| status.as_str()) {
        Some("success") => true,
        Some("error") => !retry_failed,
        Some("running") => false,
        _ => false,
    }
}

fn upsert_running_result(
    db: &Database,
    existing_id: Option<&str>,
    run_id: &str,
    experiment_id: &str,
    row_index: i64,
    model: &str,
    row: &serde_json::Map<String, serde_json::Value>,
    input_system: &str,
    input_user: &str,
) -> Result<String, AppError> {
    let source_row = serde_json::to_string(row)?;
    let conn = db.conn.lock().unwrap();
    if let Some(id) = existing_id {
        conn.execute(
            "UPDATE llm_run_results
             SET status = 'running', source_row = ?2, input_system = ?3, input_user = ?4,
                 output = NULL, error = NULL, token_usage = NULL, latency_ms = NULL,
                 updated_at = datetime('now')
             WHERE id = ?1",
            rusqlite::params![id, source_row, input_system, input_user],
        )?;
        return Ok(id.to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO llm_run_results
            (id, run_id, experiment_id, row_index, model, status, source_row, input_system, input_user)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8)",
        rusqlite::params![
            id,
            run_id,
            experiment_id,
            row_index,
            model,
            source_row,
            input_system,
            input_user
        ],
    )?;
    Ok(id)
}

fn update_result_success(
    db: &Database,
    result_id: &str,
    output: &str,
    token_usage: Option<&AiTokenUsage>,
    latency_ms: i64,
) -> Result<(), AppError> {
    let token_usage = token_usage.map(serde_json::to_string).transpose()?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE llm_run_results
         SET status = 'success', output = ?2, error = NULL, token_usage = ?3,
             latency_ms = ?4, updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![result_id, output, token_usage, latency_ms],
    )?;
    Ok(())
}

fn update_result_error(
    db: &Database,
    result_id: &str,
    error: &str,
    latency_ms: i64,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE llm_run_results
         SET status = 'error', error = ?2, latency_ms = ?3, updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![result_id, error, latency_ms],
    )?;
    Ok(())
}

fn update_run_status_counts(
    db: &Database,
    run_id: &str,
    status: &str,
    completed_at_expr: Option<&str>,
) -> Result<(), AppError> {
    let conn = db.conn.lock().unwrap();
    let completed_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM llm_run_results WHERE run_id = ?1 AND status IN ('success', 'error')",
        rusqlite::params![run_id],
        |row| row.get(0),
    )?;
    let failed_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM llm_run_results WHERE run_id = ?1 AND status = 'error'",
        rusqlite::params![run_id],
        |row| row.get(0),
    )?;
    let sql = if let Some(expr) = completed_at_expr {
        format!(
            "UPDATE llm_runs SET status = ?2, completed_count = ?3, failed_count = ?4, requested_action = NULL, completed_at = {} WHERE id = ?1",
            expr
        )
    } else {
        "UPDATE llm_runs SET status = ?2, completed_count = ?3, failed_count = ?4, requested_action = NULL WHERE id = ?1".to_string()
    };
    conn.execute(
        &sql,
        rusqlite::params![run_id, status, completed_count, failed_count],
    )?;
    Ok(())
}

fn run_experiment_id(db: &Database, run_id: &str) -> Result<String, AppError> {
    let conn = db.conn.lock().unwrap();
    Ok(conn.query_row(
        "SELECT experiment_id FROM llm_runs WHERE id = ?1",
        rusqlite::params![run_id],
        |row| row.get(0),
    )?)
}

fn load_experiment(conn: &rusqlite::Connection, id: &str) -> Result<LlmExperiment, AppError> {
    Ok(conn.query_row(
        "SELECT id, name, input_source_type, data_source_id, sql_text, selected_columns,
                system_prompt, user_prompt, models, created_at, updated_at
         FROM llm_experiments WHERE id = ?1",
        rusqlite::params![id],
        parse_experiment_row,
    )?)
}

fn parse_experiment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LlmExperiment> {
    let selected_columns: String = row.get(5)?;
    let models: String = row.get(8)?;
    Ok(LlmExperiment {
        id: row.get(0)?,
        name: row.get(1)?,
        input_source_type: row.get(2)?,
        data_source_id: row.get(3)?,
        sql_text: row.get(4)?,
        selected_columns: serde_json::from_str(&selected_columns).unwrap_or_default(),
        system_prompt: row.get(6)?,
        user_prompt: row.get(7)?,
        models: serde_json::from_str(&models).unwrap_or_default(),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn load_run(conn: &rusqlite::Connection, id: &str) -> Result<LlmRun, AppError> {
    Ok(conn.query_row(
        "SELECT r.id, r.experiment_id, e.name, r.status, r.total_count, r.completed_count,
                r.failed_count, r.requested_action, r.started_at, r.completed_at
         FROM llm_runs r
         JOIN llm_experiments e ON e.id = r.experiment_id
         WHERE r.id = ?1",
        rusqlite::params![id],
        parse_run_row,
    )?)
}

fn parse_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LlmRun> {
    Ok(LlmRun {
        id: row.get(0)?,
        experiment_id: row.get(1)?,
        experiment_name: row.get(2)?,
        status: row.get(3)?,
        total_count: row.get(4)?,
        completed_count: row.get(5)?,
        failed_count: row.get(6)?,
        requested_action: row.get(7)?,
        started_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}

fn list_run_results(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<Vec<LlmRunResult>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, run_id, experiment_id, row_index, model, status, source_row, input_system,
                input_user, output, error, token_usage, latency_ms, created_at, updated_at
         FROM llm_run_results WHERE run_id = ?1 ORDER BY row_index, model",
    )?;
    let rows = stmt.query_map(rusqlite::params![run_id], |row| {
        Ok(LlmRunResult {
            id: row.get(0)?,
            run_id: row.get(1)?,
            experiment_id: row.get(2)?,
            row_index: row.get(3)?,
            model: row.get(4)?,
            status: row.get(5)?,
            source_row: row.get(6)?,
            input_system: row.get(7)?,
            input_user: row.get(8)?,
            output: row.get(9)?,
            error: row.get(10)?,
            token_usage: row.get(11)?,
            latency_ms: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn total_tokens(
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    cache_write_tokens: Option<i64>,
) -> Option<i64> {
    let values = [
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
    ];
    if values.iter().all(Option::is_none) {
        None
    } else {
        Some(values.into_iter().flatten().sum())
    }
}

fn emit_progress(
    app: &AppHandle,
    run_id: &str,
    experiment_id: &str,
    kind: &str,
    status: &str,
    row_index: Option<i64>,
    model: Option<&str>,
    message: &str,
) {
    emit_progress_with_counts(
        app,
        run_id,
        experiment_id,
        kind,
        status,
        row_index,
        model,
        0,
        0,
        0,
        message,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_progress_with_counts(
    app: &AppHandle,
    run_id: &str,
    experiment_id: &str,
    kind: &str,
    status: &str,
    row_index: Option<i64>,
    model: Option<&str>,
    completed_count: i64,
    failed_count: i64,
    total_count: i64,
    message: &str,
) {
    let _ = app.emit(
        "llm-run-progress",
        LlmRunProgress {
            run_id: run_id.to_string(),
            experiment_id: experiment_id.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
            row_index,
            model: model.map(str::to_string),
            completed_count,
            failed_count,
            total_count,
            message: Some(message.to_string()),
        },
    );
}

#[allow(dead_code)]
fn row_to_object(
    columns: &[String],
    values: Vec<serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    columns.iter().cloned().zip(values).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_row(row_index: i64, value: serde_json::Value) -> InputRow {
        InputRow {
            row_index,
            data: serde_json::Map::from_iter([("text".to_string(), value)]),
        }
    }

    fn batch_draft() -> LlmExperimentDraft {
        LlmExperimentDraft {
            id: None,
            name: String::new(),
            input_source_type: "sql".to_string(),
            data_source_id: None,
            sql_text: Some("SELECT 1".to_string()),
            selected_columns: vec!["text".to_string()],
            system_prompt: "Classify {{text}}".to_string(),
            user_prompt: "Input: {{text}}".to_string(),
            models: Vec::new(),
        }
    }

    #[test]
    fn builds_responses_request_with_rendered_prompts() {
        let request = build_openai_batch_request(
            &input_row(7, serde_json::json!("hello")),
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "System: {{text}}",
            "User: {{text}}",
            &OpenAiBatchOptions::default(),
        );

        assert_eq!(request.custom_id, "row-7");
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "/v1/responses");
        assert_eq!(request.body["model"], "gpt-test");
        assert_eq!(request.body["instructions"], "System: hello");
        assert_eq!(request.body["input"], "User: hello");
    }

    #[test]
    fn builds_chat_request_and_uses_system_only_fallback() {
        let request = build_openai_batch_request(
            &input_row(2, serde_json::json!("hello")),
            "gpt-test",
            OpenAiBatchEndpoint::ChatCompletions,
            "System: {{text}}",
            "",
            &OpenAiBatchOptions::default(),
        );

        assert_eq!(request.url, "/v1/chat/completions");
        assert_eq!(request.body["messages"][0]["role"], "system");
        assert_eq!(request.body["messages"][0]["content"], "System: hello");
        assert_eq!(request.body["messages"][1]["role"], "user");
        assert_eq!(
            request.body["messages"][1]["content"],
            EMPTY_USER_PROMPT_FALLBACK
        );
    }

    #[test]
    fn writes_one_valid_json_value_per_line_with_unique_ids() {
        let rows = vec![
            input_row(0, serde_json::json!("first\nline")),
            input_row(1, serde_json::json!("second")),
        ];
        let mut output = Vec::new();

        let (request_count, byte_count) = write_openai_batch_jsonl(
            &mut output,
            &rows,
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &OpenAiBatchOptions::default(),
        )
        .unwrap();

        assert_eq!(request_count, 2);
        assert_eq!(byte_count as usize, output.len());
        let lines = String::from_utf8(output).unwrap();
        let requests = lines
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["custom_id"], "row-0");
        assert_eq!(requests[0]["body"]["input"], "first\nline");
        assert_eq!(requests[1]["custom_id"], "row-1");
    }

    #[test]
    fn rejects_missing_model_without_requiring_a_copilot_model() {
        let draft = batch_draft();

        assert!(validate_batch_export_draft(&draft, "").is_err());
        assert!(validate_batch_export_draft(&draft, "gpt-test").is_ok());
    }

    #[test]
    fn adds_common_and_advanced_options_to_responses_requests() {
        let options = OpenAiBatchOptions {
            temperature: Some(0.4),
            top_p: Some(0.8),
            max_output_tokens: Some(512),
            advanced: serde_json::Map::from_iter([(
                "metadata".to_string(),
                serde_json::json!({"source": "data-explorer"}),
            )]),
        };

        let request = build_openai_batch_request(
            &input_row(0, serde_json::json!("hello")),
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &options,
        );

        assert_eq!(request.body["temperature"], 0.4);
        assert_eq!(request.body["top_p"], 0.8);
        assert_eq!(request.body["max_output_tokens"], 512);
        assert_eq!(request.body["metadata"]["source"], "data-explorer");
        assert!(request.body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn uses_chat_completions_token_limit_name() {
        let options = OpenAiBatchOptions {
            max_output_tokens: Some(256),
            ..Default::default()
        };

        let request = build_openai_batch_request(
            &input_row(0, serde_json::json!("hello")),
            "gpt-test",
            OpenAiBatchEndpoint::ChatCompletions,
            "",
            "{{text}}",
            &options,
        );

        assert_eq!(request.body["max_completion_tokens"], 256);
        assert!(request.body.get("max_output_tokens").is_none());
    }

    #[test]
    fn rejects_invalid_and_conflicting_options() {
        assert!(validate_openai_batch_options(&OpenAiBatchOptions {
            temperature: Some(2.1),
            ..Default::default()
        })
        .is_err());
        assert!(validate_openai_batch_options(&OpenAiBatchOptions {
            top_p: Some(-0.1),
            ..Default::default()
        })
        .is_err());
        assert!(validate_openai_batch_options(&OpenAiBatchOptions {
            max_output_tokens: Some(0),
            ..Default::default()
        })
        .is_err());
        assert!(validate_openai_batch_options(&OpenAiBatchOptions {
            advanced: serde_json::Map::from_iter([(
                "model".to_string(),
                serde_json::json!("override"),
            )]),
            ..Default::default()
        })
        .is_err());
        assert!(validate_openai_batch_options(&OpenAiBatchOptions {
            advanced: serde_json::Map::from_iter([(
                "response_format".to_string(),
                serde_json::json!({"type": "json_object"}),
            )]),
            ..Default::default()
        })
        .is_ok());
    }

    #[test]
    fn rejects_unknown_prompt_columns() {
        let mut draft = batch_draft();
        draft.user_prompt = "{{missing}}".to_string();

        assert!(validate_batch_export_draft(&draft, "gpt-test").is_err());
    }

    #[test]
    fn validates_placeholders_against_materialized_columns_when_all_are_selected() {
        let mut draft = batch_draft();
        draft.selected_columns.clear();
        draft.user_prompt = "{{missing}}".to_string();

        assert!(validate_batch_export_draft(&draft, "gpt-test").is_ok());
        assert!(validate_prompt_placeholders_against_columns(
            &draft.system_prompt,
            &draft.user_prompt,
            ["text"]
        )
        .is_err());
    }

    #[test]
    fn plans_chunks_at_request_and_byte_limits() {
        let fifty_thousand = (0..OPENAI_BATCH_MAX_REQUESTS)
            .map(|index| (index as i64, 1))
            .collect::<Vec<_>>();
        let one_chunk = plan_openai_batch_chunk_sizes(
            &fifty_thousand,
            OPENAI_BATCH_MAX_REQUESTS,
            OPENAI_BATCH_MAX_BYTES,
        )
        .unwrap();
        assert_eq!(
            one_chunk,
            vec![OpenAiBatchChunk {
                start: 0,
                end: OPENAI_BATCH_MAX_REQUESTS,
                byte_count: OPENAI_BATCH_MAX_REQUESTS as u64,
            }]
        );

        let mut fifty_thousand_and_one = fifty_thousand;
        fifty_thousand_and_one.push((OPENAI_BATCH_MAX_REQUESTS as i64, 1));
        let two_chunks = plan_openai_batch_chunk_sizes(
            &fifty_thousand_and_one,
            OPENAI_BATCH_MAX_REQUESTS,
            OPENAI_BATCH_MAX_BYTES,
        )
        .unwrap();
        assert_eq!(two_chunks.len(), 2);
        assert_eq!(two_chunks[0].end - two_chunks[0].start, 50_000);
        assert_eq!(two_chunks[1].end - two_chunks[1].start, 1);

        let size_chunks =
            plan_openai_batch_chunk_sizes(&[(0, 6), (1, 4), (2, 1)], 50_000, 10).unwrap();
        assert_eq!(
            size_chunks,
            vec![
                OpenAiBatchChunk {
                    start: 0,
                    end: 2,
                    byte_count: 10,
                },
                OpenAiBatchChunk {
                    start: 2,
                    end: 3,
                    byte_count: 1,
                },
            ]
        );
    }

    #[test]
    fn rejects_a_single_request_larger_than_a_batch_file() {
        let error = plan_openai_batch_chunk_sizes(&[(42, 11)], 50_000, 10).unwrap_err();
        assert!(error.to_string().contains("row 42"));
        assert!(error.to_string().contains("200 MB"));
    }

    #[test]
    fn preserves_single_path_and_numbers_multiple_parts() {
        let destination = Path::new("reports").join("export.jsonl");
        assert_eq!(
            split_destination_paths(&destination.to_string_lossy(), 1).unwrap(),
            vec![destination.clone()]
        );
        assert_eq!(
            split_destination_paths(&destination.to_string_lossy(), 3).unwrap(),
            vec![
                Path::new("reports").join("export-part-0001-of-0003.jsonl"),
                Path::new("reports").join("export-part-0002-of-0003.jsonl"),
                Path::new("reports").join("export-part-0003-of-0003.jsonl"),
            ]
        );
    }

    #[test]
    fn writes_global_request_ids_across_parts() {
        let directory =
            std::env::temp_dir().join(format!("data-explorer-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let rows = vec![
            input_row(0, serde_json::json!("first")),
            input_row(1, serde_json::json!("second")),
        ];
        let chunks = plan_openai_batch_chunks(
            &rows,
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &OpenAiBatchOptions::default(),
            1,
            OPENAI_BATCH_MAX_BYTES,
        )
        .unwrap();
        let paths = vec![
            directory.join("part-1.jsonl"),
            directory.join("part-2.jsonl"),
        ];

        let files = write_openai_batch_parts(
            &paths,
            &chunks,
            &rows,
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &OpenAiBatchOptions::default(),
        )
        .unwrap();

        assert_eq!(files.len(), 2);
        assert_eq!(
            files.iter().map(|file| file.request_count).sum::<usize>(),
            2
        );
        assert_eq!(
            files.iter().map(|file| file.byte_count).sum::<u64>(),
            chunks.iter().map(|chunk| chunk.byte_count).sum::<u64>()
        );
        let first: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&paths[0]).unwrap().trim()).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&paths[1]).unwrap().trim()).unwrap();
        assert_eq!(first["custom_id"], "row-0");
        assert_eq!(second["custom_id"], "row-1");

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn removes_earlier_parts_when_a_later_write_fails() {
        let directory =
            std::env::temp_dir().join(format!("data-explorer-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let rows = vec![
            input_row(0, serde_json::json!("first")),
            input_row(1, serde_json::json!("second")),
        ];
        let chunks = plan_openai_batch_chunks(
            &rows,
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &OpenAiBatchOptions::default(),
            1,
            OPENAI_BATCH_MAX_BYTES,
        )
        .unwrap();
        let first_path = directory.join("part-1.jsonl");
        let paths = vec![
            first_path.clone(),
            directory.join("missing").join("part-2.jsonl"),
        ];

        assert!(write_openai_batch_parts(
            &paths,
            &chunks,
            &rows,
            "gpt-test",
            OpenAiBatchEndpoint::Responses,
            "",
            "{{text}}",
            &OpenAiBatchOptions::default(),
        )
        .is_err());
        assert!(!first_path.exists());

        std::fs::remove_dir_all(directory).unwrap();
    }
}
