use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use copilot_sdk::{
    generated::{
        AssistantMessageData, AssistantMessageDeltaData, AssistantUsageData, SessionErrorData,
        SessionModelChangeData, SessionStartData,
    },
    Client, ClientOptions, SessionConfig, SystemMessageConfig,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::ai::AiTokenUsage;
use crate::db::Database;
use crate::duckdb_engine::{DuckDbEngine, SourcePreview};
use crate::error::AppError;
use crate::prompt_template;

const LLM_ROW_TIMEOUT: Duration = Duration::from_secs(120);

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
        columns: preview.columns.iter().map(|(name, _)| name.clone()).collect(),
        column_types: preview
            .columns
            .iter()
            .map(|(_, data_type)| data_type.clone())
            .collect(),
        rows: preview.rows,
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
    execute_run(app, db.inner().clone(), duckdb.inner().clone(), experiment_id, run_id, false).await
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
    execute_run(app, db.inner().clone(), duckdb.inner().clone(), experiment_id, run_id, false).await
}

#[tauri::command]
pub async fn retry_failed_llm_run(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    run_id: String,
) -> Result<LlmRun, AppError> {
    let experiment_id = run_experiment_id(db.inner(), &run_id)?;
    execute_run(app, db.inner().clone(), duckdb.inner().clone(), experiment_id, run_id, true).await
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
        return Err(AppError::General("Select at least one Copilot model.".to_string()));
    }
    if experiment.user_prompt.trim().is_empty() && experiment.system_prompt.trim().is_empty() {
        return Err(AppError::General(
            "Add a system or user prompt before starting an LLM run.".to_string(),
        ));
    }

    let rows = materialize_input_rows(&db, &duckdb, &experiment)?;
    if rows.is_empty() {
        return Err(AppError::General("The selected input has no rows.".to_string()));
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
    let result = execute_run_with_client(
        &app,
        &db,
        &client,
        &experiment,
        &run_id,
        rows,
        retry_failed,
    )
    .await;
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

            let rendered_system = prompt_template::interpolate(&experiment.system_prompt, &row.data);
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
            let response = run_copilot_prompt(client, model, &rendered_system, &rendered_user).await;
            let latency_ms = start.elapsed().as_millis() as i64;
            match response {
                Ok((output, usage)) => update_result_success(
                    db,
                    &result_id,
                    &output,
                    usage.as_ref(),
                    latency_ms,
                )?,
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
        .with_available_tools(Vec::<String>::new())
        .with_excluded_tools(["shell", "write", "edit", "read", "grep", "glob"])
        .with_client_name("data-explorer-llm-runs")
        .with_system_message(
            SystemMessageConfig::new()
                .with_mode("replace")
                .with_content(system_content),
        );
    config.model = Some(model.to_string());
    config.request_permission = Some(false);
    let session = client.create_session(config).await?;
    let mut events = session.subscribe();
    let prompt = if user_prompt.trim().is_empty() {
        "Process this row according to the system prompt.".to_string()
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
                        return Err(AppError::General(format!("Copilot session error: {}", err.message)));
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
) -> Result<Vec<InputRow>, AppError> {
    let preview = materialize_preview(
        db,
        duckdb,
        &experiment.input_source_type,
        experiment.data_source_id.as_deref(),
        experiment.sql_text.as_deref(),
        None,
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
            let (file_path, file_format): (String, String) = conn.query_row(
                "SELECT file_path, file_format FROM data_sources WHERE id = ?1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            drop(conn);
            duckdb.source_rows(&file_path, &file_format, limit)
        }
        "sql" => {
            let sql = sql_text
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::General("Enter SQL for this LLM experiment.".to_string()))?;
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
    let columns = indexes.iter().map(|index| preview.columns[*index].clone()).collect();
    let rows = preview
        .rows
        .into_iter()
        .map(|row| indexes.iter().map(|index| row[*index].clone()).collect())
        .collect();
    Ok(SourcePreview { columns, rows })
}

fn validate_experiment_draft(draft: &LlmExperimentDraft) -> Result<(), AppError> {
    if draft.name.trim().is_empty() {
        return Err(AppError::General("Name the LLM experiment.".to_string()));
    }
    if draft.models.is_empty() {
        return Err(AppError::General("Select at least one Copilot model.".to_string()));
    }
    if draft.system_prompt.trim().is_empty() && draft.user_prompt.trim().is_empty() {
        return Err(AppError::General(
            "Add a system or user prompt before saving.".to_string(),
        ));
    }
    let available: std::collections::HashSet<&str> =
        draft.selected_columns.iter().map(String::as_str).collect();
    for placeholder in prompt_template::extract_placeholders(&draft.system_prompt)
        .into_iter()
        .chain(prompt_template::extract_placeholders(&draft.user_prompt))
    {
        if !available.is_empty() && !available.contains(placeholder.as_str()) {
            return Err(AppError::General(format!(
                "Prompt references a column that is not selected: {}",
                placeholder
            )));
        }
    }
    Ok(())
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

fn load_experiment(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<LlmExperiment, AppError> {
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
    input_tokens: Option<f64>,
    output_tokens: Option<f64>,
    cache_read_tokens: Option<f64>,
    cache_write_tokens: Option<f64>,
) -> Option<f64> {
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
fn row_to_object(columns: &[String], values: Vec<serde_json::Value>) -> HashMap<String, serde_json::Value> {
    columns.iter().cloned().zip(values).collect()
}
