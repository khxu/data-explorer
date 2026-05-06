import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  listAiModels,
  draftSqlQuery,
  type AiModel,
  type AiTokenUsage,
  type DataSource,
} from "@/lib/api";

interface AiSqlAssistantProps {
  currentSql: string;
  dataSources: DataSource[];
  onApplySql: (sql: string) => void;
  onClose: () => void;
}

const DEFAULT_MODEL_VALUE = "__copilot_default__";
const MAX_ACTIVITY_ITEMS = 8;
const MAX_REASONING_CHARS = 800;

interface AiDraftProgress {
  request_id: string;
  kind: "status" | "reasoning" | "answer" | "usage" | "done";
  message: string | null;
  delta: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

export function AiSqlAssistant({
  currentSql,
  dataSources,
  onApplySql,
  onClose,
}: AiSqlAssistantProps) {
  const [models, setModels] = useState<AiModel[]>([]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_VALUE);
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState("");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [streamedDraft, setStreamedDraft] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [reasoning, setReasoning] = useState("");
  const [tokenUsage, setTokenUsage] = useState<string | null>(null);
  const [draftTokenUsage, setDraftTokenUsage] = useState<AiTokenUsage | null>(null);
  const [selectedDataSourceIds, setSelectedDataSourceIds] = useState<string[]>(() =>
    dataSources.map((source) => source.id)
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  const selectedDataSources = useMemo(
    () => dataSources.filter((source) => selectedDataSourceIds.includes(source.id)),
    [dataSources, selectedDataSourceIds]
  );

  useEffect(() => {
    setSelectedDataSourceIds((previousIds) => {
      const availableIds = new Set(dataSources.map((source) => source.id));
      const keptIds = previousIds.filter((id) => availableIds.has(id));
      const newIds = dataSources
        .map((source) => source.id)
        .filter((id) => !previousIds.includes(id));
      return [...keptIds, ...newIds];
    });
  }, [dataSources]);

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    listAiModels()
      .then((nextModels) => {
        if (!cancelled) {
          setModels(nextModels);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModels(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    listen<AiDraftProgress>("ai-sql-assistant-progress", (event) => {
      if (event.payload.request_id !== activeRequestIdRef.current) return;

      if (event.payload.kind === "answer" && event.payload.delta) {
        setStreamedDraft((current) => current + event.payload.delta);
        return;
      }

      if (event.payload.kind === "reasoning" && event.payload.delta) {
        setReasoning((current) =>
          (current + event.payload.delta).slice(-MAX_REASONING_CHARS)
        );
        return;
      }

      if (event.payload.kind === "usage") {
        const input = Math.round(event.payload.input_tokens ?? 0);
        const output = Math.round(event.payload.output_tokens ?? 0);
        const cached =
          Math.round(event.payload.cache_read_tokens ?? 0) +
          Math.round(event.payload.cache_write_tokens ?? 0);
        const cachedLabel =
          cached > 0 ? `, ${cached.toLocaleString()} cached` : "";
        setTokenUsage(`Tokens: ${input.toLocaleString()} in, ${output.toLocaleString()} out${cachedLabel}`);
      }

      if (event.payload.message) {
        setActivity((current) => [
          event.payload.message as string,
          ...current,
        ].slice(0, MAX_ACTIVITY_ITEMS));
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  async function handleDraft() {
    if (!request.trim()) {
      setError("Describe the query you want help drafting.");
      return;
    }
    if (selectedDataSourceIds.length === 0) {
      setError("Select at least one table to include as context.");
      return;
    }
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    setDrafting(true);
    setError(null);
    setDraft("");
    setDraftModel(null);
    setDraftTokenUsage(null);
    setStreamedDraft("");
    setReasoning("");
    setTokenUsage(null);
    setActivity(["Preparing selected table context."]);
    try {
      const response = await draftSqlQuery(
        requestId,
        request,
        selectedModel === DEFAULT_MODEL_VALUE ? null : selectedModel,
        selectedModel === DEFAULT_MODEL_VALUE
          ? "Copilot default model"
          : models.find((model) => model.id === selectedModel)?.name ?? selectedModel,
        currentSql,
        selectedDataSourceIds
      );
      setDraft(response.sql);
      setDraftModel(formatModelLabel(response.model_used, models));
      setDraftTokenUsage(response.token_usage);
      setStreamedDraft("");
    } catch (e) {
      setError(String(e));
    } finally {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
      }
      setDrafting(false);
    }
  }

  return (
    <aside className="w-80 flex-shrink-0 border-l bg-muted/20 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">AI SQL Assistant</h2>
          <p className="text-xs text-muted-foreground">
            Uses selected schemas and first 2 sample rows
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose}>
          ✕
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Model</label>
          <Select
            value={selectedModel}
            onValueChange={setSelectedModel}
            disabled={loadingModels || drafting}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={loadingModels ? "Loading models..." : "Choose model"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL_VALUE}>Copilot default</SelectItem>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name || model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 rounded-md border bg-background p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              Context: {selectedDataSources.length} of {dataSources.length} table
              {dataSources.length === 1 ? "" : "s"}
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setSelectedDataSourceIds(dataSources.map((source) => source.id))}
                disabled={drafting || dataSources.length === 0}
              >
                All
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setSelectedDataSourceIds([])}
                disabled={drafting || dataSources.length === 0}
              >
                None
              </Button>
            </div>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {dataSources.map((source) => (
              <label
                key={source.id}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={selectedDataSourceIds.includes(source.id)}
                  disabled={drafting}
                  onChange={(event) => {
                    setSelectedDataSourceIds((previousIds) =>
                      event.target.checked
                        ? [...previousIds, source.id]
                        : previousIds.filter((id) => id !== source.id)
                    );
                  }}
                />
                <span className="min-w-0 flex-1 truncate" title={source.name}>
                  {source.name}
                </span>
                <span className="text-muted-foreground">{source.file_format}</span>
              </label>
            ))}
            {dataSources.length === 0 && (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">
                No data sources registered
              </p>
            )}
          </div>
          {selectedDataSources.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Selected: {selectedDataSources.map((source) => source.name).join(", ")}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            What do you want to query?
          </label>
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="e.g. Show monthly revenue by region for the last year"
            className="min-h-28 resize-none"
            disabled={drafting}
          />
        </div>

        <Button
          size="sm"
          className="w-full"
          onClick={handleDraft}
          disabled={drafting || selectedDataSourceIds.length === 0}
        >
          {drafting ? "Drafting..." : "Draft SQL"}
        </Button>

        {drafting && (
          <div className="space-y-2 rounded-md border bg-background p-2 text-xs">
            <div className="flex items-center gap-2 font-medium">
              <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
              Working on your SQL draft
            </div>
            <div className="space-y-1 text-muted-foreground">
              {activity.map((item, index) => (
                <p key={`${item}-${index}`}>{item}</p>
              ))}
            </div>
            {reasoning.trim() && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  Show model reasoning stream
                </summary>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2">
                  {reasoning}
                </pre>
              </details>
            )}
            {streamedDraft.trim() && (
              <div className="space-y-1">
                <p className="font-medium">Live draft</p>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2">
                  {streamedDraft}
                </pre>
              </div>
            )}
            {tokenUsage && <p className="text-muted-foreground">{tokenUsage}</p>}
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {draft && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Draft</label>
                {draftModel && (
                  <p className="text-xs text-muted-foreground">Generated with {draftModel}</p>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={() => onApplySql(draft)}>
                Insert
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
              {draft}
            </pre>
            {draftTokenUsage && (
              <div className="rounded-md border bg-background p-2 text-xs">
                <p className="mb-1 font-medium text-muted-foreground">Token usage</p>
                <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                  {formatTokenUsageRows(draftTokenUsage).map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <span>{label}</span>
                      <span className="font-mono text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function formatModelLabel(modelId: string | null, models: AiModel[]) {
  if (!modelId) return "Copilot default model";
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return modelId;
  if (!model.name || model.name === modelId) return modelId;
  return `${model.name} (${modelId})`;
}

function formatTokenUsageRows(usage: AiTokenUsage): [string, string][] {
  return [
    ["Input", formatTokenCount(usage.input_tokens)],
    ["Output", formatTokenCount(usage.output_tokens)],
    ["Cache read", formatTokenCount(usage.cache_read_tokens)],
    ["Cache write", formatTokenCount(usage.cache_write_tokens)],
    ["Total", formatTokenCount(usage.total_tokens)],
  ];
}

function formatTokenCount(value: number | null) {
  if (value === null || value === undefined) return "n/a";
  return Math.round(value).toLocaleString();
}
