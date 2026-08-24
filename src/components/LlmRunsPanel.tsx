import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppState } from "@/hooks/useAppState";
import { OpenAiBatchExportDialog } from "./OpenAiBatchExportDialog";
import {
  cancelLlmRun,
  deleteLlmExperiment,
  getLlmRunResults,
  listAiModels,
  listLlmExperiments,
  listLlmRuns,
  pauseLlmRun,
  previewLlmInput,
  retryFailedLlmRun,
  resumeLlmRun,
  saveLlmExperiment,
  startLlmRun,
  type AiModel,
  type LlmExperiment,
  type LlmExperimentDraft,
  type LlmInputPreview,
  type LlmRun,
  type LlmRunProgress,
  type LlmRunResult,
} from "@/lib/api";
import { unknownPlaceholders } from "@/lib/promptTemplate";

const DEFAULT_FORM: LlmExperimentDraft = {
  name: "",
  input_source_type: "data_source",
  data_source_id: null,
  sql_text: "",
  selected_columns: [],
  system_prompt: "You process one data row at a time.",
  user_prompt: "",
  models: [],
};

export function LlmRunsPanel() {
  const { dataSources } = useAppState();
  const [experiments, setExperiments] = useState<LlmExperiment[]>([]);
  const [runs, setRuns] = useState<LlmRun[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [form, setForm] = useState<LlmExperimentDraft>(DEFAULT_FORM);
  const [preview, setPreview] = useState<LlmInputPreview | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [results, setResults] = useState<LlmRunResult[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<LlmRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBatchExport, setShowBatchExport] = useState(false);
  const systemPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const userPromptRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    const [nextExperiments, nextRuns] = await Promise.all([
      listLlmExperiments(),
      listLlmRuns(),
    ]);
    setExperiments(nextExperiments);
    setRuns(nextRuns);
    if (!selectedRunId && nextRuns.length > 0) {
      setSelectedRunId(nextRuns[0].id);
    }
  }, [selectedRunId]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    listAiModels().then(setModels).catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    listen<LlmRunProgress>("llm-run-progress", (event) => {
      setProgress(event.payload);
      setActiveRunId(event.payload.run_id);
      if (event.payload.kind === "result" || event.payload.kind === "done") {
        void refresh();
        if (event.payload.run_id === selectedRunId) {
          void loadResults(event.payload.run_id);
        }
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [refresh, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setResults([]);
      return;
    }
    loadResults(selectedRunId).catch((e) => setError(String(e)));
  }, [selectedRunId]);

  const availableColumns = preview?.columns ?? [];
  const promptWarnings = [
    ...unknownPlaceholders(form.system_prompt, availableColumns),
    ...unknownPlaceholders(form.user_prompt, availableColumns),
  ];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const activeRun = activeRunId ? runs.find((run) => run.id === activeRunId) : null;

  async function loadResults(runId: string) {
    setResults(await getLlmRunResults(runId));
  }

  async function handlePreview() {
    setError(null);
    try {
      const nextPreview = await previewLlmInput(
        form.input_source_type,
        form.data_source_id ?? null,
        form.sql_text ?? null,
        [],
        25
      );
      setPreview(nextPreview);
      setForm((current) => ({
        ...current,
        selected_columns:
          current.selected_columns.length > 0
            ? current.selected_columns.filter((column) => nextPreview.columns.includes(column))
            : nextPreview.columns,
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveLlmExperiment(form);
      setForm(experimentToDraft(saved));
      await refresh();
      return saved;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleRun() {
    const saved = await handleSave();
    if (!saved) return;
    setBusy(true);
    setActiveRunId(null);
    setProgress(null);
    try {
      const run = await startLlmRun(saved.id);
      setSelectedRunId(run.id);
      await refresh();
      await loadResults(run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunAction(action: "pause" | "cancel" | "resume" | "retry") {
    const runId = activeRunId ?? selectedRunId;
    if (!runId) return;
    setError(null);
    try {
      if (action === "pause") await pauseLlmRun(runId);
      if (action === "cancel") await cancelLlmRun(runId);
      if (action === "resume") await resumeLlmRun(runId);
      if (action === "retry") await retryFailedLlmRun(runId);
      await refresh();
      await loadResults(runId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDeleteExperiment(id: string) {
    setError(null);
    try {
      await deleteLlmExperiment(id);
      if (form.id === id) {
        setForm(DEFAULT_FORM);
        setPreview(null);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function insertColumn(column: string, target: "system" | "user") {
    const token = `{{${column}}}`;
    const key = target === "system" ? "system_prompt" : "user_prompt";
    const ref = target === "system" ? systemPromptRef : userPromptRef;
    const textarea = ref.current;
    const value = form[key] ?? "";
    if (!textarea) {
      setForm((current) => ({ ...current, [key]: `${value}${token}` }));
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setForm((current) => ({
      ...current,
      [key]: value.slice(0, start) + token + value.slice(end),
    }));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + token.length;
    });
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[26rem] flex-shrink-0 border-r overflow-y-auto p-3 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">LLM Runs</h2>
          <Button size="sm" variant="outline" onClick={() => { setForm(DEFAULT_FORM); setPreview(null); }}>
            New
          </Button>
        </div>

        {error && <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

        <div className="space-y-2">
          <label className="text-xs font-medium">Name</label>
          <input
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Classify support tickets"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <label className="text-xs font-medium">Input</label>
            <select
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              value={form.input_source_type}
              onChange={(event) => {
                const value = event.target.value as "data_source" | "sql";
                setForm({ ...form, input_source_type: value });
                setPreview(null);
              }}
            >
              <option value="data_source">Data source</option>
              <option value="sql">SQL result</option>
            </select>
          </div>
          {form.input_source_type === "data_source" && (
            <div className="space-y-2">
              <label className="text-xs font-medium">Source</label>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={form.data_source_id ?? ""}
                onChange={(event) => {
                  setForm({ ...form, data_source_id: event.target.value || null });
                  setPreview(null);
                }}
              >
                <option value="">Choose</option>
                {dataSources.map((source) => (
                  <option key={source.id} value={source.id}>{source.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {form.input_source_type === "sql" && (
          <div className="space-y-2">
            <label className="text-xs font-medium">SQL input</label>
            <Textarea
              value={form.sql_text ?? ""}
              onChange={(event) => setForm({ ...form, sql_text: event.target.value })}
              className="min-h-24 font-mono text-xs"
              placeholder="SELECT id, text FROM my_table LIMIT 100"
            />
          </div>
        )}

        <Button size="sm" variant="outline" onClick={handlePreview}>
          Preview columns
        </Button>

        {preview && (
          <div className="space-y-2 rounded-md border p-2">
            <div className="text-xs font-medium">Columns available to prompts</div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {preview.columns.map((column) => (
                <label key={column} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.selected_columns.includes(column)}
                    onChange={(event) => {
                      setForm((current) => ({
                        ...current,
                        selected_columns: event.target.checked
                          ? [...current.selected_columns, column]
                          : current.selected_columns.filter((value) => value !== column),
                      }));
                    }}
                  />
                  <span className="truncate">{column}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {form.selected_columns.map((column) => (
                <button
                  key={column}
                  type="button"
                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] hover:bg-accent"
                  onClick={() => insertColumn(column, "user")}
                  title="Insert into user prompt"
                >
                  {column}
                </button>
              ))}
            </div>
          </div>
        )}

        <PromptBox
          label="System prompt"
          value={form.system_prompt}
          textareaRef={systemPromptRef}
          onChange={(value) => setForm({ ...form, system_prompt: value })}
        />
        <PromptBox
          label="User prompt"
          value={form.user_prompt}
          textareaRef={userPromptRef}
          onChange={(value) => setForm({ ...form, user_prompt: value })}
        />
        {promptWarnings.length > 0 && (
          <p className="text-xs text-amber-600">
            Unknown placeholders: {Array.from(new Set(promptWarnings)).join(", ")}
          </p>
        )}

        <div className="space-y-2 rounded-md border p-2">
          <div className="text-xs font-medium">Copilot run models</div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {models.map((model) => (
              <label key={model.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.models.includes(model.id)}
                  onChange={(event) => {
                    setForm((current) => ({
                      ...current,
                      models: event.target.checked
                        ? [...current.models, model.id]
                        : current.models.filter((value) => value !== model.id),
                    }));
                  }}
                />
                <span className="truncate">{model.name || model.id}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={busy}>Save</Button>
          <Button size="sm" onClick={handleRun} disabled={busy}>Run</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowBatchExport(true)}
            disabled={busy}
          >
            Export Batch JSONL
          </Button>
          {(activeRun?.status === "running" || busy) && (
            <>
              <Button size="sm" variant="outline" onClick={() => void handleRunAction("pause")}>Pause</Button>
              <Button size="sm" variant="destructive" onClick={() => void handleRunAction("cancel")}>Cancel</Button>
            </>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">Saved experiments</h3>
          {experiments.map((experiment) => (
            <div key={experiment.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <button
                  className="truncate text-left font-medium hover:underline"
                  onClick={() => {
                    setForm(experimentToDraft(experiment));
                    setPreview(null);
                  }}
                >
                  {experiment.name}
                </button>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void handleDeleteExperiment(experiment.id)}>
                  Delete
                </Button>
              </div>
              <div className="text-muted-foreground">{experiment.models.length} model{experiment.models.length === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="border-b p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Run history</h3>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>Refresh</Button>
          </div>
          {progress && (
            <ProgressSummary progress={progress} />
          )}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {runs.map((run) => (
              <button
                key={run.id}
                className={`rounded-md border px-2 py-1 text-left text-xs ${run.id === selectedRunId ? "bg-accent" : "bg-background"}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <div className="font-medium whitespace-nowrap">{run.experiment_name}</div>
                <div className="text-muted-foreground whitespace-nowrap">
                  {run.status} · {run.completed_count}/{run.total_count}
                  {run.failed_count ? ` · ${run.failed_count} failed` : ""}
                </div>
              </button>
            ))}
          </div>
          {selectedRun && (
            <div className="flex gap-2">
              {selectedRun.status === "paused" && (
                <Button size="sm" onClick={() => void handleRunAction("resume")}>Resume</Button>
              )}
              {selectedRun.failed_count > 0 && (
                <Button size="sm" variant="outline" onClick={() => void handleRunAction("retry")}>
                  Retry failed
                </Button>
              )}
              {results.length > 0 && (
                <>
                  <Button size="sm" variant="outline" onClick={() => exportResultsFile(selectedRun, results, "csv")}>
                    Export CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => exportResultsFile(selectedRun, results, "json")}>
                    Export JSON
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <ResultsTable results={results} />
      </div>

      <OpenAiBatchExportDialog
        open={showBatchExport}
        onClose={() => setShowBatchExport(false)}
        draft={form}
      />
    </div>
  );
}

function PromptBox({
  label,
  value,
  textareaRef,
  onChange,
}: {
  label: string;
  value: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium">{label}</label>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24 text-xs"
      />
    </div>
  );
}

function ProgressSummary({ progress }: { progress: LlmRunProgress }) {
  const total = progress.total_count || 0;
  const completed = progress.completed_count || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="rounded-md border p-2 text-xs">
      <div className="flex items-center justify-between">
        <span>{progress.message ?? progress.status}</span>
        <span>{completed}/{total} · {pct}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-muted">
        <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
      </div>
      {progress.model && (
        <div className="mt-1 text-muted-foreground">
          Row {progress.row_index} · {progress.model}
        </div>
      )}
    </div>
  );
}

function ResultsTable({ results }: { results: LlmRunResult[] }) {
  const pivot = useMemo(() => buildPivot(results), [results]);
  const [detail, setDetail] = useState<LlmRunResult | null>(null);

  if (results.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">No run results selected</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-background">
          <tr>
            <th className="border px-2 py-1 text-left">Row</th>
            {pivot.sourceColumns.map((column) => (
              <th key={column} className="border px-2 py-1 text-left">{column}</th>
            ))}
            {pivot.models.map((model) => (
              <th key={model} className="border px-2 py-1 text-left">{model}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map((row) => (
            <tr key={row.rowIndex}>
              <td className="border px-2 py-1 text-muted-foreground">{row.rowIndex}</td>
              {pivot.sourceColumns.map((column) => (
                <td key={column} className="max-w-48 truncate border px-2 py-1">{formatValue(row.source[column])}</td>
              ))}
              {pivot.models.map((model) => {
                const result = row.resultsByModel[model];
                return (
                  <td key={model} className="max-w-72 truncate border px-2 py-1">
                    {result ? (
                      <button className="text-left hover:underline" onClick={() => setDetail(result)}>
                        {result.status === "success" ? "✓" : result.status === "error" ? "✗" : "…"} {result.output ?? result.error ?? result.status}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {detail && (
        <div className="fixed inset-x-6 bottom-6 z-40 max-h-[45vh] overflow-auto rounded-lg border bg-popover p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Row {detail.row_index} · {detail.model}</div>
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>Close</Button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <DetailBlock label="System prompt" value={detail.input_system} />
            <DetailBlock label="User prompt" value={detail.input_user} />
          </div>
          <DetailBlock label={detail.status === "error" ? "Error" : "Output"} value={detail.output ?? detail.error} />
          <div className="text-xs text-muted-foreground">
            Status: {detail.status}
            {detail.latency_ms != null ? ` · ${detail.latency_ms}ms` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{value ?? ""}</pre>
    </div>
  );
}

function experimentToDraft(experiment: LlmExperiment): LlmExperimentDraft {
  return {
    id: experiment.id,
    name: experiment.name,
    input_source_type: experiment.input_source_type,
    data_source_id: experiment.data_source_id,
    sql_text: experiment.sql_text ?? "",
    selected_columns: experiment.selected_columns,
    system_prompt: experiment.system_prompt,
    user_prompt: experiment.user_prompt,
    models: experiment.models,
  };
}

function buildPivot(results: LlmRunResult[]) {
  const models = Array.from(new Set(results.map((result) => result.model)));
  const sourceColumns = Array.from(
    new Set(results.flatMap((result) => Object.keys(parseSourceRow(result.source_row))))
  );
  const rowsByIndex = new Map<number, {
    rowIndex: number;
    source: Record<string, unknown>;
    resultsByModel: Record<string, LlmRunResult>;
  }>();

  for (const result of results) {
    const source = parseSourceRow(result.source_row);
    const existing = rowsByIndex.get(result.row_index) ?? {
      rowIndex: result.row_index,
      source,
      resultsByModel: {},
    };
    existing.resultsByModel[result.model] = result;
    rowsByIndex.set(result.row_index, existing);
  }

  return {
    models,
    sourceColumns,
    rows: Array.from(rowsByIndex.values()).sort((a, b) => a.rowIndex - b.rowIndex),
  };
}

function parseSourceRow(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function exportResultsFile(run: LlmRun, results: LlmRunResult[], format: "csv" | "json") {
  const pivot = buildPivot(results);
  const rows = pivot.rows.map((row) => {
    const outputRow: Record<string, unknown> = { row_index: row.rowIndex, ...row.source };
    for (const model of pivot.models) {
      const result = row.resultsByModel[model];
      outputRow[`${model}_status`] = result?.status ?? "";
      outputRow[`${model}_output`] = result?.output ?? "";
      outputRow[`${model}_error`] = result?.error ?? "";
      outputRow[`${model}_latency_ms`] = result?.latency_ms ?? "";
    }
    return outputRow;
  });

  const filename = `${safeFilename(run.experiment_name)}-${run.id}.${format}`;
  if (format === "json") {
    downloadBlob(filename, "application/json", JSON.stringify(rows, null, 2));
    return;
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : ["row_index"];
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
  downloadBlob(filename, "text/csv", csv);
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function safeFilename(value: string) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "llm-run";
}

function downloadBlob(filename: string, type: string, content: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
