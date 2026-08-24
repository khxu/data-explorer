import { invoke } from "@tauri-apps/api/core";

// -- Data Sources --

export interface DataSource {
  id: string;
  name: string;
  file_path: string;
  file_paths: string[];
  file_format: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface DataSourceColumn {
  name: string;
  data_type: string;
}

export interface DataSourceSchema {
  data_source_id: string;
  name: string;
  columns: DataSourceColumn[];
}

export async function registerDataSource(
  name: string,
  filePaths: string[]
): Promise<DataSource> {
  return invoke("register_data_source", { name, filePaths });
}

export async function removeDataSource(id: string): Promise<void> {
  return invoke("remove_data_source", { id });
}

export async function refreshDataSource(id: string): Promise<void> {
  return invoke("refresh_data_source", { id });
}

export async function refreshAllDataSources(): Promise<void> {
  return invoke("refresh_all_data_sources");
}

export async function listDataSources(
  tagIds?: string[]
): Promise<DataSource[]> {
  return invoke("list_data_sources", { tagIds: tagIds ?? null });
}

export async function getDataSourceSchema(
  id: string
): Promise<DataSourceSchema> {
  return invoke("get_data_source_schema", { id });
}

// -- Tags --

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export async function createTag(
  name: string,
  color?: string
): Promise<Tag> {
  return invoke("create_tag", { name, color: color ?? null });
}

export async function deleteTag(id: string): Promise<void> {
  return invoke("delete_tag", { id });
}

export async function listTags(): Promise<Tag[]> {
  return invoke("list_tags");
}

export async function assignTags(
  dataSourceId: string,
  tagIds: string[]
): Promise<void> {
  return invoke("assign_tags", { dataSourceId, tagIds });
}

export async function removeTags(
  dataSourceId: string,
  tagIds: string[]
): Promise<void> {
  return invoke("remove_tags", { dataSourceId, tagIds });
}

// -- Projects --

export interface Project {
  id: string;
  name: string;
  description: string | null;
  tag_filter: string[];
  created_at: string;
  updated_at: string;
}

export async function createProject(
  name: string,
  description: string | null,
  tagFilter: string[]
): Promise<Project> {
  return invoke("create_project", { name, description, tagFilter });
}

export async function updateProject(
  id: string,
  name: string,
  description: string | null,
  tagFilter: string[]
): Promise<void> {
  return invoke("update_project", { id, name, description, tagFilter });
}

export async function deleteProject(id: string): Promise<void> {
  return invoke("delete_project", { id });
}

export async function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

// -- Queries --

export interface QueryResult {
  columns: string[];
  column_types: string[];
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
  export_table_name: string | null;
}

export interface QueryHistoryEntry {
  id: string;
  sql_text: string;
  status: string;
  error_message: string | null;
  row_count: number | null;
  execution_time_ms: number | null;
  result_sample: string | null;
  created_at: string;
}

export async function executeQuery(sql: string): Promise<QueryResult> {
  return invoke("execute_query", { sql });
}

export async function cancelQuery(): Promise<boolean> {
  return invoke("cancel_query");
}

export async function releaseQueryResult(exportTableName: string): Promise<boolean> {
  return invoke("release_query_result", { exportTableName });
}

export async function getStandaloneSql(sql: string): Promise<string> {
  return invoke("get_standalone_sql", { sql });
}

export async function getQueryHistory(
  limit?: number,
  offset?: number
): Promise<QueryHistoryEntry[]> {
  return invoke("get_query_history", {
    limit: limit ?? 50,
    offset: offset ?? 0,
  });
}

export async function clearQueryHistory(before?: string): Promise<number> {
  return invoke("clear_query_history", { before: before ?? null });
}

// -- AI SQL Assistant --

export interface AiModel {
  id: string;
  name: string;
  supported_reasoning_efforts: string[] | null;
  default_reasoning_effort: string | null;
}

export interface AiColumnContext {
  name: string;
  data_type: string;
}

export interface AiDataSourceContext {
  data_source_id: string;
  name: string;
  file_format: string;
  columns: AiColumnContext[];
  sample_rows: unknown[][];
}

export interface AiDraftResponse {
  sql: string;
  context: AiDataSourceContext[];
  model_used: string | null;
  token_usage: AiTokenUsage | null;
}

export interface AiTokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
}

export interface AiAssistHistoryEntry {
  id: string;
  prompt_text: string;
  generated_sql: string;
  requested_model: string | null;
  model_used: string | null;
  model_name: string | null;
  token_usage: string | null;
  created_at: string;
}

export async function listAiModels(): Promise<AiModel[]> {
  return invoke("list_ai_models");
}

export async function draftSqlQuery(
  requestId: string,
  request: string,
  model: string | null,
  modelName: string | null,
  currentSql: string,
  dataSourceIds: string[]
): Promise<AiDraftResponse> {
  return invoke("draft_sql_query", {
    requestId,
    request,
    model,
    modelName,
    currentSql,
    dataSourceIds,
  });
}

export async function getAiAssistHistory(
  limit?: number,
  offset?: number
): Promise<AiAssistHistoryEntry[]> {
  return invoke("get_ai_assist_history", {
    limit: limit ?? 50,
    offset: offset ?? 0,
  });
}

export async function clearAiAssistHistory(before?: string): Promise<number> {
  return invoke("clear_ai_assist_history", { before: before ?? null });
}

// -- Query Tabs --

export interface SavedQueryTab {
  id: string;
  name: string;
  sql_text: string;
  project_id: string | null;
  sort_order: number;
  is_active: boolean;
  result_cache: QueryResult | null;
}

export async function loadQueryTabs(): Promise<SavedQueryTab[]> {
  return invoke("load_query_tabs");
}

export async function saveQueryTabs(tabs: SavedQueryTab[]): Promise<void> {
  return invoke("save_query_tabs", { tabs });
}

// -- Export --

export async function exportResults(
  sql: string,
  format: string,
  destinationPath: string,
  resultTableName?: string | null
): Promise<string> {
  return invoke("export_results", {
    sql,
    format,
    destinationPath,
    resultTableName: resultTableName ?? null,
  });
}

// -- LLM Runs --

export interface LlmExperiment {
  id: string;
  name: string;
  input_source_type: "data_source" | "sql";
  data_source_id: string | null;
  sql_text: string | null;
  selected_columns: string[];
  system_prompt: string;
  user_prompt: string;
  models: string[];
  created_at: string;
  updated_at: string;
}

export interface LlmExperimentDraft {
  id?: string | null;
  name: string;
  input_source_type: "data_source" | "sql";
  data_source_id?: string | null;
  sql_text?: string | null;
  selected_columns: string[];
  system_prompt: string;
  user_prompt: string;
  models: string[];
}

export interface LlmRun {
  id: string;
  experiment_id: string;
  experiment_name: string;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  requested_action: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface LlmRunResult {
  id: string;
  run_id: string;
  experiment_id: string;
  row_index: number;
  model: string;
  status: string;
  source_row: string;
  input_system: string | null;
  input_user: string | null;
  output: string | null;
  error: string | null;
  token_usage: string | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface LlmInputPreview {
  columns: string[];
  column_types: string[];
  rows: unknown[][];
}

export interface LlmRunProgress {
  run_id: string;
  experiment_id: string;
  kind: string;
  status: string;
  row_index: number | null;
  model: string | null;
  completed_count: number;
  failed_count: number;
  total_count: number;
  message: string | null;
}

export type OpenAiBatchEndpoint = "responses" | "chat_completions";

export interface OpenAiCredentialStatus {
  configured: boolean;
}

export interface OpenAiBatchOptions {
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  advanced: Record<string, unknown>;
}

export interface OpenAiBatchExportFile {
  destination_path: string;
  request_count: number;
  byte_count: number;
}

export interface OpenAiBatchExportResult {
  files: OpenAiBatchExportFile[];
  request_count: number;
  byte_count: number;
}

export async function getOpenAiCredentialStatus(): Promise<OpenAiCredentialStatus> {
  return invoke("get_openai_credential_status");
}

export async function setOpenAiApiKey(apiKey: string): Promise<OpenAiCredentialStatus> {
  return invoke("set_openai_api_key", { apiKey });
}

export async function deleteOpenAiApiKey(): Promise<OpenAiCredentialStatus> {
  return invoke("delete_openai_api_key");
}

export async function listOpenAiModels(): Promise<string[]> {
  return invoke("list_openai_models");
}

export async function listLlmExperiments(): Promise<LlmExperiment[]> {
  return invoke("list_llm_experiments");
}

export async function saveLlmExperiment(
  draft: LlmExperimentDraft
): Promise<LlmExperiment> {
  return invoke("save_llm_experiment", { draft });
}

export async function deleteLlmExperiment(id: string): Promise<void> {
  return invoke("delete_llm_experiment", { id });
}

export async function previewLlmInput(
  inputSourceType: "data_source" | "sql",
  dataSourceId: string | null,
  sqlText: string | null,
  selectedColumns: string[],
  limit = 25
): Promise<LlmInputPreview> {
  return invoke("preview_llm_input", {
    inputSourceType,
    dataSourceId,
    sqlText,
    selectedColumns,
    limit,
  });
}

export async function exportOpenAiBatchJsonl(
  draft: LlmExperimentDraft,
  model: string,
  endpoint: OpenAiBatchEndpoint,
  options: OpenAiBatchOptions,
  destinationPath: string
): Promise<OpenAiBatchExportResult> {
  return invoke("export_openai_batch_jsonl", {
    draft,
    model,
    endpoint,
    options,
    destinationPath,
  });
}

export async function listLlmRuns(): Promise<LlmRun[]> {
  return invoke("list_llm_runs");
}

export async function getLlmRunResults(runId: string): Promise<LlmRunResult[]> {
  return invoke("get_llm_run_results", { runId });
}

export async function startLlmRun(experimentId: string): Promise<LlmRun> {
  return invoke("start_llm_run", { experimentId });
}

export async function pauseLlmRun(runId: string): Promise<void> {
  return invoke("pause_llm_run", { runId });
}

export async function cancelLlmRun(runId: string): Promise<void> {
  return invoke("cancel_llm_run", { runId });
}

export async function resumeLlmRun(runId: string): Promise<LlmRun> {
  return invoke("resume_llm_run", { runId });
}

export async function retryFailedLlmRun(runId: string): Promise<LlmRun> {
  return invoke("retry_failed_llm_run", { runId });
}
