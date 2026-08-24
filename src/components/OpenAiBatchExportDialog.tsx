import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteOpenAiApiKey,
  exportOpenAiBatchJsonl,
  getOpenAiCredentialStatus,
  listOpenAiModels,
  setOpenAiApiKey,
  type LlmExperimentDraft,
  type OpenAiBatchEndpoint,
  type OpenAiBatchOptions,
} from "@/lib/api";

const ENDPOINT_STORAGE_KEY = "llm-runs-openai-batch-endpoint";
const MODEL_STORAGE_KEY = "llm-runs-openai-batch-model";
const OPTIONS_STORAGE_KEY = "llm-runs-openai-batch-options";
const RESERVED_ADVANCED_KEYS = new Set([
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
]);

interface Props {
  open: boolean;
  onClose: () => void;
  draft: LlmExperimentDraft;
}

interface PersistedOptions {
  temperature: string;
  topP: string;
  maxOutputTokens: string;
  advancedJson: string;
}

const DEFAULT_OPTIONS: PersistedOptions = {
  temperature: "",
  topP: "",
  maxOutputTokens: "",
  advancedJson: "",
};

function loadEndpoint(): OpenAiBatchEndpoint {
  try {
    const value = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
    return value === "chat_completions" ? value : "responses";
  } catch (error) {
    console.warn("Unable to load the OpenAI Batch endpoint preference", error);
    return "responses";
  }
}

function loadModel() {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  } catch (error) {
    console.warn("Unable to load the OpenAI Batch model preference", error);
    return "";
  }
}

function loadOptions(): PersistedOptions {
  try {
    const value = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
    if (!value) return DEFAULT_OPTIONS;
    const parsed = JSON.parse(value) as Partial<PersistedOptions>;
    return {
      temperature: typeof parsed.temperature === "string" ? parsed.temperature : "",
      topP: typeof parsed.topP === "string" ? parsed.topP : "",
      maxOutputTokens:
        typeof parsed.maxOutputTokens === "string" ? parsed.maxOutputTokens : "",
      advancedJson: typeof parsed.advancedJson === "string" ? parsed.advancedJson : "",
    };
  } catch (error) {
    console.warn("Unable to load the OpenAI Batch options preference", error);
    return DEFAULT_OPTIONS;
  }
}

export function OpenAiBatchExportDialog({ open, onClose, draft }: Props) {
  const [endpoint, setEndpoint] = useState<OpenAiBatchEndpoint>(loadEndpoint);
  const [model, setModel] = useState(loadModel);
  const [persistedOptions, setPersistedOptions] = useState(loadOptions);
  const [destinationPath, setDestinationPath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const optionsResult = useMemo(
    () => parseBatchOptions(persistedOptions),
    [persistedOptions]
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint);
    } catch (storageError) {
      console.warn("Unable to save the OpenAI Batch endpoint preference", storageError);
    }
  }, [endpoint]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch (storageError) {
      console.warn("Unable to save the OpenAI Batch model preference", storageError);
    }
  }, [model]);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(persistedOptions));
    } catch (storageError) {
      console.warn("Unable to save the OpenAI Batch options preference", storageError);
    }
  }, [persistedOptions]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModelsError(null);
    getOpenAiCredentialStatus()
      .then((status) => {
        if (cancelled) return;
        setCredentialConfigured(status.configured);
        if (status.configured) {
          void refreshModels(() => cancelled);
        }
      })
      .catch((statusError) => {
        if (!cancelled) setModelsError(String(statusError));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function refreshModels(isCancelled: () => boolean = () => false) {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const nextModels = await listOpenAiModels();
      if (!isCancelled()) setModels(nextModels);
    } catch (modelError) {
      if (!isCancelled()) setModelsError(String(modelError));
    } finally {
      if (!isCancelled()) setModelsLoading(false);
    }
  }

  async function saveApiKey() {
    if (!apiKey.trim()) return;
    setCredentialLoading(true);
    setModelsError(null);
    try {
      const status = await setOpenAiApiKey(apiKey);
      setCredentialConfigured(status.configured);
      setApiKey("");
      await refreshModels();
    } catch (credentialError) {
      setModelsError(String(credentialError));
    } finally {
      setCredentialLoading(false);
    }
  }

  async function removeApiKey() {
    setCredentialLoading(true);
    setModelsError(null);
    try {
      const status = await deleteOpenAiApiKey();
      setCredentialConfigured(status.configured);
      setApiKey("");
      setModels([]);
    } catch (credentialError) {
      setModelsError(String(credentialError));
    } finally {
      setCredentialLoading(false);
    }
  }

  async function pickDestination() {
    const result = await save({
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      defaultPath: `${safeFilename(draft.name)}-openai-batch.jsonl`,
    });
    if (result) {
      setDestinationPath(result);
      setError(null);
      setSuccess(null);
    }
  }

  async function handleExport() {
    if (!model.trim() || !destinationPath || !optionsResult.options) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await exportOpenAiBatchJsonl(
        draft,
        model.trim(),
        endpoint,
        optionsResult.options,
        destinationPath
      );
      setSuccess(formatExportSuccess(result));
    } catch (exportError) {
      setError(String(exportError));
    } finally {
      setLoading(false);
    }
  }

  const customModel = modelSearch.trim();
  const showCustomModel = customModel.length > 0 && !models.includes(customModel);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export OpenAI Batch JSONL</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Generates one Batch API request per input row and automatically splits files at
            50,000 requests or 200 MB.
          </p>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="openai-api-key">OpenAI API key</Label>
                <p className="text-xs text-muted-foreground">
                  {credentialConfigured
                    ? "Stored securely in your OS keychain."
                    : "Optional. Used only to discover available model IDs."}
                </p>
              </div>
              {credentialConfigured && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={removeApiKey}
                  disabled={credentialLoading}
                >
                  Remove
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                id="openai-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={credentialConfigured ? "Enter a replacement key" : "sk-..."}
              />
              <Button
                variant="outline"
                onClick={saveApiKey}
                disabled={!apiKey.trim() || credentialLoading}
              >
                {credentialLoading ? "Saving..." : credentialConfigured ? "Replace" : "Save"}
              </Button>
            </div>
            {modelsError && <p className="text-xs text-destructive">{modelsError}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Endpoint</Label>
              <Select
                value={endpoint}
                onValueChange={(value) => setEndpoint(value as OpenAiBatchEndpoint)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="responses">Responses API (/v1/responses)</SelectItem>
                  <SelectItem value="chat_completions">
                    Chat Completions (/v1/chat/completions)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>OpenAI model ID</Label>
                {credentialConfigured && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => refreshModels()}
                    disabled={modelsLoading}
                  >
                    {modelsLoading ? "Refreshing..." : "Refresh"}
                  </Button>
                )}
              </div>
              <Popover
                open={modelPickerOpen}
                onOpenChange={(nextOpen) => {
                  setModelPickerOpen(nextOpen);
                  if (nextOpen) setModelSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={modelPickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="truncate">{model || "Choose or enter a model ID"}</span>
                    <ChevronDownIcon className="opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                  <Command>
                    <CommandInput
                      value={modelSearch}
                      onValueChange={setModelSearch}
                      placeholder="Search or enter a model ID..."
                    />
                    <CommandList>
                      <CommandEmpty>
                        {modelsLoading ? "Loading models..." : "Type a custom model ID."}
                      </CommandEmpty>
                      {showCustomModel && (
                        <CommandGroup heading="Custom">
                          <CommandItem
                            value={customModel}
                            onSelect={() => {
                              setModel(customModel);
                              setModelPickerOpen(false);
                            }}
                          >
                            Use "{customModel}"
                          </CommandItem>
                        </CommandGroup>
                      )}
                      {models.length > 0 && (
                        <CommandGroup heading="Available models">
                          {models.map((modelId) => (
                            <CommandItem
                              key={modelId}
                              value={modelId}
                              data-checked={modelId === model}
                              onSelect={() => {
                                setModel(modelId);
                                setModelPickerOpen(false);
                              }}
                            >
                              {modelId}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                OpenAI does not identify Batch-compatible models; custom IDs are allowed.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>Generation settings</Label>
              <p className="text-xs text-muted-foreground">
                Leave fields blank to use the model defaults.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="openai-temperature">Temperature</Label>
                <Input
                  id="openai-temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={persistedOptions.temperature}
                  onChange={(event) =>
                    setPersistedOptions((current) => ({
                      ...current,
                      temperature: event.target.value,
                    }))
                  }
                  placeholder="0-2"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="openai-top-p">Top-p</Label>
                <Input
                  id="openai-top-p"
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={persistedOptions.topP}
                  onChange={(event) =>
                    setPersistedOptions((current) => ({
                      ...current,
                      topP: event.target.value,
                    }))
                  }
                  placeholder="0-1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="openai-max-output-tokens">Max output tokens</Label>
                <Input
                  id="openai-max-output-tokens"
                  type="number"
                  min="1"
                  step="1"
                  value={persistedOptions.maxOutputTokens}
                  onChange={(event) =>
                    setPersistedOptions((current) => ({
                      ...current,
                      maxOutputTokens: event.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
                <p className="text-xs text-muted-foreground">
                  {endpoint === "responses" ? "max_output_tokens" : "max_completion_tokens"}
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="openai-advanced-json">Advanced request fields (JSON object)</Label>
              <Textarea
                id="openai-advanced-json"
                value={persistedOptions.advancedJson}
                onChange={(event) =>
                  setPersistedOptions((current) => ({
                    ...current,
                    advancedJson: event.target.value,
                  }))
                }
                placeholder={'{\n  "reasoning": { "effort": "low" }\n}'}
                className="min-h-24 font-mono text-xs"
                aria-invalid={Boolean(optionsResult.error)}
              />
              <p className="text-xs text-muted-foreground">
                Add endpoint-specific fields. Generated prompts, model, streaming, and typed settings cannot be overridden.
              </p>
              {optionsResult.error && (
                <p className="text-xs text-destructive">{optionsResult.error}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Destination</Label>
            <div className="flex gap-2">
              <Input
                value={destinationPath}
                placeholder="Choose save location or split-file template..."
                readOnly
                className="flex-1"
              />
              <Button variant="outline" onClick={pickDestination}>
                Browse
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600">{success}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={handleExport}
            disabled={
              !model.trim() ||
              !destinationPath ||
              loading ||
              Boolean(optionsResult.error)
            }
          >
            {loading ? "Exporting..." : "Export JSONL"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function parseBatchOptions(
  options: PersistedOptions
): { options: OpenAiBatchOptions | null; error: string | null } {
  try {
    const temperature = parseOptionalNumber(options.temperature, "Temperature", 0, 2);
    const topP = parseOptionalNumber(options.topP, "Top-p", 0, 1);
    const maxOutputTokens = parseOptionalNumber(
      options.maxOutputTokens,
      "Maximum output tokens",
      1,
      Number.MAX_SAFE_INTEGER,
      true
    );
    let advanced: Record<string, unknown> = {};
    if (options.advancedJson.trim()) {
      const parsed: unknown = JSON.parse(options.advancedJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Advanced request fields must be a JSON object.");
      }
      advanced = parsed as Record<string, unknown>;
      const reservedKey = Object.keys(advanced).find((key) =>
        RESERVED_ADVANCED_KEYS.has(key)
      );
      if (reservedKey) {
        throw new Error(`Advanced request fields cannot set reserved field "${reservedKey}".`);
      }
    }
    return {
      options: { temperature, topP, maxOutputTokens, advanced },
      error: null,
    };
  } catch (validationError) {
    return { options: null, error: String(validationError) };
  }
}

function parseOptionalNumber(
  rawValue: string,
  label: string,
  min: number,
  max: number,
  integer = false
) {
  if (!rawValue.trim()) return null;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number.`);
  }
  return value;
}

function safeFilename(value: string) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "llm-run";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExportSuccess(result: {
  files: Array<{ destination_path: string }>;
  request_count: number;
  byte_count: number;
}) {
  const summary = `Exported ${result.request_count.toLocaleString()} requests (${formatBytes(result.byte_count)})`;
  if (result.files.length === 1) {
    return `${summary} to ${result.files[0].destination_path}`;
  }
  const firstPath = result.files[0]?.destination_path;
  const lastPath = result.files[result.files.length - 1]?.destination_path;
  return `${summary} across ${result.files.length.toLocaleString()} files: ${firstPath} through ${lastPath}`;
}
