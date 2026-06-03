use std::sync::Arc;
use std::time::Duration;

use copilot_sdk::{
    session_events::{
        AssistantMessageData, AssistantMessageDeltaData, AssistantReasoningData,
        AssistantReasoningDeltaData, AssistantUsageData, SessionErrorData, SessionModelChangeData,
        SessionStartData,
    },
    Client, ClientOptions, SessionConfig, SystemMessageConfig,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::duckdb_engine::DuckDbEngine;
use crate::error::AppError;

const SAMPLE_ROW_LIMIT: usize = 2;
const SQL_DRAFT_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiModel {
    pub id: String,
    pub name: String,
    pub supported_reasoning_efforts: Option<Vec<String>>,
    pub default_reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AiModelListResponse {
    models: Vec<AiModelResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiModelResponse {
    id: String,
    name: String,
    #[serde(default)]
    supported_reasoning_efforts: Vec<String>,
    default_reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiColumnContext {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiDataSourceContext {
    pub data_source_id: String,
    pub name: String,
    pub file_format: String,
    pub columns: Vec<AiColumnContext>,
    pub sample_rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiDraftResponse {
    pub sql: String,
    pub context: Vec<AiDataSourceContext>,
    pub model_used: Option<String>,
    pub token_usage: Option<AiTokenUsage>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiTokenUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiAssistHistoryEntry {
    pub id: String,
    pub prompt_text: String,
    pub generated_sql: String,
    pub requested_model: Option<String>,
    pub model_used: Option<String>,
    pub model_name: Option<String>,
    pub token_usage: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AiDraftProgress {
    pub request_id: String,
    pub kind: String,
    pub message: Option<String>,
    pub delta: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
}

#[tauri::command]
pub async fn list_ai_models() -> Result<Vec<AiModel>, AppError> {
    let client = build_copilot_client().await?;
    let result = async {
        let response = client
            .call("models.list", Some(serde_json::json!({})))
            .await?;
        parse_ai_models(response)
    }
    .await;
    stop_copilot_client(&client, result).await
}

fn parse_ai_models(response: serde_json::Value) -> Result<Vec<AiModel>, AppError> {
    let model_list: AiModelListResponse = serde_json::from_value(response)?;
    Ok(model_list
        .models
        .into_iter()
        .map(|model| AiModel {
            id: model.id,
            name: model.name,
            supported_reasoning_efforts: Some(model.supported_reasoning_efforts),
            default_reasoning_effort: model.default_reasoning_effort,
        })
        .collect())
}

#[tauri::command]
pub async fn draft_sql_query(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    duckdb: State<'_, Arc<DuckDbEngine>>,
    request_id: String,
    request: String,
    model: Option<String>,
    model_name: Option<String>,
    current_sql: Option<String>,
    data_source_ids: Option<Vec<String>>,
) -> Result<AiDraftResponse, AppError> {
    if request.trim().is_empty() {
        return Err(AppError::General(
            "Describe the query you want help drafting.".to_string(),
        ));
    }

    emit_progress(
        &app,
        &request_id,
        "status",
        Some("Collecting selected table schemas and sample rows."),
        None,
        None,
        None,
        None,
        None,
    );
    let context = build_ai_context(db.inner(), duckdb.inner(), data_source_ids)?;
    if context.is_empty() {
        return Err(AppError::General(
            "Register at least one data source before asking for SQL assistance.".to_string(),
        ));
    }

    let prompt = build_sql_prompt(&request, current_sql.as_deref(), &context)?;
    let client = build_copilot_client().await?;
    emit_progress(
        &app,
        &request_id,
        "status",
        Some("Starting Copilot session."),
        None,
        None,
        None,
        None,
        None,
    );
    let requested_model = model.filter(|value| !value.trim().is_empty());
    let result = async {
        let mut config = SessionConfig::default()
            .with_streaming(true)
            .with_available_tools(Vec::<String>::new())
            .with_excluded_tools(["shell", "write", "edit", "read", "grep", "glob"])
            .deny_all_permissions()
            .with_client_name("data-explorer-sql-assistant")
            .with_system_message(
                SystemMessageConfig::new()
                    .with_mode("replace")
                    .with_content("You are a SQL assistant for a DuckDB data exploration app. Draft a single read-only DuckDB SQL query. Use only the table names and columns provided by the app context. Return SQL only, with no markdown fences, explanations, or commentary."),
            );
        config.model = requested_model.clone();
        let session = client.create_session(config).await?;
        let model_label = requested_model
            .as_deref()
            .unwrap_or("the Copilot default model");
        emit_progress(
            &app,
            &request_id,
            "status",
            Some(&format!("Sending prompt and context to {}.", model_label)),
            None,
            None,
            None,
            None,
            None,
        );
        let (response, observed_model, token_usage) =
            collect_sql_draft_with_progress(&app, &request_id, &session, prompt).await?;
        let sql = normalize_sql_draft(&response);
        if sql.is_empty() {
            return Err(AppError::General(
                "The AI assistant did not return a SQL draft.".to_string(),
            ));
        }
        let model_used = observed_model.or_else(|| requested_model.clone());
        emit_progress(
            &app,
            &request_id,
            "done",
            Some("SQL draft ready."),
            None,
            None,
            None,
            None,
            None,
        );
        let response = AiDraftResponse {
            sql,
            context,
            model_used,
            token_usage,
        };
        save_ai_assist_history(
            db.inner(),
            &request,
            &response.sql,
            requested_model.as_deref(),
            response.model_used.as_deref(),
            model_name.as_deref(),
            response.token_usage.as_ref(),
        )?;
        Ok::<_, AppError>(response)
    }
    .await;
    stop_copilot_client(&client, result).await
}

#[tauri::command]
pub fn get_ai_assist_history(
    db: State<'_, Arc<Database>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AiAssistHistoryEntry>, AppError> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, prompt_text, generated_sql, requested_model, model_used, model_name, token_usage, created_at
         FROM ai_assist_history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
        Ok(AiAssistHistoryEntry {
            id: row.get(0)?,
            prompt_text: row.get(1)?,
            generated_sql: row.get(2)?,
            requested_model: row.get(3)?,
            model_used: row.get(4)?,
            model_name: row.get(5)?,
            token_usage: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn clear_ai_assist_history(
    db: State<'_, Arc<Database>>,
    before: Option<String>,
) -> Result<u64, AppError> {
    let conn = db.conn.lock().unwrap();
    let affected = if let Some(before_date) = before {
        conn.execute(
            "DELETE FROM ai_assist_history WHERE created_at < ?1",
            rusqlite::params![before_date],
        )?
    } else {
        conn.execute("DELETE FROM ai_assist_history", [])?
    };
    Ok(affected as u64)
}

fn save_ai_assist_history(
    db: &Database,
    prompt_text: &str,
    generated_sql: &str,
    requested_model: Option<&str>,
    model_used: Option<&str>,
    model_name: Option<&str>,
    token_usage: Option<&AiTokenUsage>,
) -> Result<(), AppError> {
    let token_usage = token_usage
        .map(serde_json::to_string)
        .transpose()?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO ai_assist_history (id, prompt_text, generated_sql, requested_model, model_used, model_name, token_usage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            prompt_text,
            generated_sql,
            requested_model,
            model_used,
            model_name,
            token_usage,
        ],
    )?;
    Ok(())
}

async fn build_copilot_client() -> Result<Client, AppError> {
    Client::start(ClientOptions::default()).await.map_err(AppError::from)
}

async fn stop_copilot_client<T>(
    client: &Client,
    result: Result<T, AppError>,
) -> Result<T, AppError> {
    let stop_result = client
        .stop()
        .await
        .map_err(|err| AppError::General(format!("Failed to stop AI assistant: {err}")));
    match (result, stop_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(err), _) => Err(err),
        (Ok(_), Err(err)) => Err(err),
    }
}

async fn collect_sql_draft_with_progress(
    app: &AppHandle,
    request_id: &str,
    session: &copilot_sdk::session::Session,
    prompt: String,
) -> Result<(String, Option<String>, Option<AiTokenUsage>), AppError> {
    let mut events = session.subscribe();
    let mut content = String::new();
    let mut saw_message_delta = false;
    let mut observed_model: Option<String> = None;
    let mut token_usage: Option<AiTokenUsage> = None;

    session.send(prompt).await?;

    tokio::time::timeout(SQL_DRAFT_TIMEOUT, async {
        loop {
            match events.recv().await {
                Ok(event) => match event.event_type.as_str() {
                    "session.start" => {
                        let start: SessionStartData = serde_json::from_value(event.data.clone())?;
                        if observed_model.is_none() {
                            observed_model = start.selected_model.clone();
                        }
                    }
                    "session.model_change" => {
                        let change: SessionModelChangeData =
                            serde_json::from_value(event.data.clone())?;
                        observed_model = Some(change.new_model.clone());
                    }
                    "assistant.turn_start" => emit_progress(
                        app,
                        request_id,
                        "status",
                        Some("Model is working through the request."),
                        None,
                        None,
                        None,
                        None,
                        None,
                    ),
                    "assistant.reasoning_delta" => {
                        let delta: AssistantReasoningDeltaData =
                            serde_json::from_value(event.data.clone())?;
                        emit_progress(
                            app,
                            request_id,
                            "reasoning",
                            None,
                            Some(&delta.delta_content),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                    "assistant.reasoning" => {
                        let reasoning: AssistantReasoningData =
                            serde_json::from_value(event.data.clone())?;
                        emit_progress(
                            app,
                            request_id,
                            "reasoning",
                            None,
                            Some(&reasoning.content),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                    "assistant.message_delta" => {
                        let delta: AssistantMessageDeltaData =
                            serde_json::from_value(event.data.clone())?;
                        saw_message_delta = true;
                        content.push_str(&delta.delta_content);
                        emit_progress(
                            app,
                            request_id,
                            "answer",
                            None,
                            Some(&delta.delta_content),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                    "assistant.message" => {
                        let message: AssistantMessageData =
                            serde_json::from_value(event.data.clone())?;
                        if !saw_message_delta {
                            content.push_str(&message.content);
                            emit_progress(
                                app,
                                request_id,
                                "answer",
                                None,
                                Some(&message.content),
                                None,
                                None,
                                None,
                                None,
                            );
                        }
                    }
                    "assistant.usage" => {
                        let usage: AssistantUsageData = serde_json::from_value(event.data.clone())?;
                        if observed_model.is_none() {
                            observed_model = Some(usage.model.clone());
                        }
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
                        emit_progress(
                            app,
                            request_id,
                            "usage",
                            Some("Token usage updated."),
                            None,
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.cache_read_tokens,
                            usage.cache_write_tokens,
                        );
                    }
                    "session.idle" => break,
                    "session.error" => {
                        let err: SessionErrorData = serde_json::from_value(event.data.clone())?;
                        return Err(AppError::General(format!(
                            "AI assistant session error: {}",
                            err.message
                        )));
                    }
                    _ => {}
                },
                Err(e) => {
                    return Err(AppError::General(format!(
                        "AI assistant event stream closed: {}",
                        e
                    )));
                }
            }
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|_| AppError::General("AI assistant timed out while drafting SQL.".to_string()))??;

    Ok((content, observed_model, token_usage))
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
    request_id: &str,
    kind: &str,
    message: Option<&str>,
    delta: Option<&str>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    cache_write_tokens: Option<i64>,
) {
    let _ = app.emit(
        "ai-sql-assistant-progress",
        AiDraftProgress {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            message: message.map(str::to_string),
            delta: delta.map(str::to_string),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
        },
    );
}

fn build_ai_context(
    db: &Database,
    duckdb: &DuckDbEngine,
    data_source_ids: Option<Vec<String>>,
) -> Result<Vec<AiDataSourceContext>, AppError> {
    let conn = db.conn.lock().unwrap();
    let sources = if let Some(ids) = data_source_ids {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut sources = Vec::new();
        for id in ids {
            let source = conn.query_row(
                "SELECT id, name, file_path, file_format FROM data_sources WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )?;
            sources.push(source);
        }
        sources
    } else {
        let mut stmt =
            conn.prepare("SELECT id, name, file_path, file_format FROM data_sources ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    drop(conn);

    sources
        .into_iter()
        .map(|(id, name, file_path, file_format)| {
            let preview = duckdb.preview_source(&file_path, &file_format, SAMPLE_ROW_LIMIT)?;
            Ok(AiDataSourceContext {
                data_source_id: id,
                name,
                file_format,
                columns: preview
                    .columns
                    .into_iter()
                    .map(|(name, data_type)| AiColumnContext { name, data_type })
                    .collect(),
                sample_rows: preview.rows,
            })
        })
        .collect()
}

fn build_sql_prompt(
    request: &str,
    current_sql: Option<&str>,
    context: &[AiDataSourceContext],
) -> Result<String, AppError> {
    let context_json = serde_json::to_string_pretty(context)?;
    let current_sql = current_sql
        .map(str::trim)
        .filter(|sql| !sql.is_empty())
        .unwrap_or("(none)");
    Ok(format!(
        "User request:\n{}\n\nCurrent SQL in the editor:\n{}\n\nAvailable DuckDB tables, columns, types, and first {} sample rows as JSON:\n{}\n\nDraft the best SQL query for the request. Prefer SELECT queries and include a reasonable LIMIT for exploratory results unless the user asks for aggregation or a complete result.",
        request.trim(),
        current_sql,
        SAMPLE_ROW_LIMIT,
        context_json
    ))
}

fn normalize_sql_draft(response: &str) -> String {
    let trimmed = response.trim();
    if let Some(fence_start) = trimmed.find("```") {
        let after_fence = &trimmed[fence_start + 3..];
        let after_language = after_fence
            .strip_prefix("sql")
            .or_else(|| after_fence.strip_prefix("SQL"))
            .unwrap_or(after_fence)
            .trim_start();
        if let Some(fence_end) = after_language.find("```") {
            return after_language[..fence_end].trim().to_string();
        }
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ai_models_ignores_incomplete_billing_metadata() {
        let models = parse_ai_models(serde_json::json!({
            "models": [
                {
                    "id": "gpt-5.5",
                    "name": "GPT-5.5",
                    "billing": {},
                    "supportedReasoningEfforts": ["low", "medium"],
                    "defaultReasoningEffort": "medium"
                }
            ]
        }))
        .expect("model list should parse");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.5");
        assert_eq!(
            models[0].supported_reasoning_efforts.as_deref(),
            Some(["low".to_string(), "medium".to_string()].as_slice())
        );
        assert_eq!(
            models[0].default_reasoning_effort.as_deref(),
            Some("medium")
        );
    }
}
