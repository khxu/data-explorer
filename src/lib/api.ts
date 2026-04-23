import { invoke } from "@tauri-apps/api/core";

// -- Data Sources --

export interface DataSource {
  id: string;
  name: string;
  file_path: string;
  file_format: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export async function registerDataSource(
  name: string,
  filePath: string
): Promise<DataSource> {
  return invoke("register_data_source", { name, filePath });
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
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
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

export async function getQueryHistory(
  limit?: number,
  offset?: number
): Promise<QueryHistoryEntry[]> {
  return invoke("get_query_history", {
    limit: limit ?? 50,
    offset: offset ?? 0,
  });
}

// -- Export --

export async function exportResults(
  sql: string,
  format: string,
  destinationPath: string
): Promise<string> {
  return invoke("export_results", { sql, format, destinationPath });
}
