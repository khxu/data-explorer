import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/hooks/useAppState";
import { cancelQuery, executeQuery, getStandaloneSql, releaseQueryResult } from "@/lib/api";
import { ExportDialog } from "./ExportDialog";
import { ResizableResultsTable } from "./ResizableResultsTable";
import { SqlEditor } from "./SqlEditor";
import {
  ALL_QUERY_TAB_PROJECTS,
  UNASSIGNED_QUERY_TAB_PROJECT,
  queryTabMatchesProjectFilter,
} from "@/hooks/useAppState";

export function QueryEditor() {
  const {
    queryTabs,
    activeQueryTabId,
    queryTabProjectFilter,
    updateQueryTab,
    addQueryTab,
    refreshHistory,
  } = useAppState();
  const [running, setRunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!running) return;

    const startedAt = performance.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 100);

    return () => window.clearInterval(timer);
  }, [running]);

  const tab = queryTabs.find((t) => t.id === activeQueryTabId);
  if (!tab || !queryTabMatchesProjectFilter(tab, queryTabProjectFilter)) {
    const projectId =
      queryTabProjectFilter === ALL_QUERY_TAB_PROJECTS
        ? undefined
        : queryTabProjectFilter !== UNASSIGNED_QUERY_TAB_PROJECT
        ? queryTabProjectFilter
        : null;
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">
            Create a query tab to start exploring this project.
          </p>
          <Button size="sm" onClick={() => addQueryTab(undefined, projectId)}>
            New query tab
          </Button>
        </div>
      </div>
    );
  }

  const tabId = tab.id;
  const sql = tab.sql;
  const result = tab.result;
  const queryError = tab.error;
  const elapsedLabel = formatElapsed(elapsedMs);

  async function handleRun() {
    if (!sql.trim()) return;
    const previousExportTableName = result?.export_table_name;
    setRunning(true);
    updateQueryTab(tabId, { error: null });
    try {
      const nextResult = await executeQuery(sql);
      updateQueryTab(tabId, { result: nextResult });
      if (
        previousExportTableName &&
        previousExportTableName !== nextResult.export_table_name
      ) {
        releaseQueryResult(previousExportTableName).catch(() => {});
      }
      await refreshHistory();
    } catch (e) {
      updateQueryTab(tabId, { error: String(e), result: null });
      if (previousExportTableName) {
        releaseQueryResult(previousExportTableName).catch(() => {});
      }
    } finally {
      setCanceling(false);
      setRunning(false);
    }
  }

  async function handleCancel() {
    if (!running || canceling) return;
    setCanceling(true);
    try {
      const cancelled = await cancelQuery();
      if (!cancelled) {
        setCanceling(false);
      }
    } catch (e) {
      updateQueryTab(tabId, { error: String(e) });
      setCanceling(false);
    }
  }

  async function handleCopySql() {
    try {
      const standalone = await getStandaloneSql(sql);
      await navigator.clipboard.writeText(standalone);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy SQL:", e);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* SQL Editor */}
      <div className="p-3 border-b space-y-2">
        <SqlEditor
          key={tabId}
          value={sql}
          onChange={(v) => updateQueryTab(tabId, { sql: v })}
          onRun={handleRun}
        />
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleRun} disabled={running || !sql.trim()} size="sm">
              {running ? `Running ${elapsedLabel}` : "▶ Run"}
            </Button>
            {running && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={canceling}
              >
                {canceling ? "Canceling..." : "Cancel"}
              </Button>
            )}
            {result && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowExport(true)}
              >
                Export
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopySql}
              disabled={!sql.trim()}
              title="Copy standalone SQL (with file references expanded) to clipboard"
            >
              {copied ? "✓ Copied" : "Copy SQL"}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">⌘+Enter to run</span>
        </div>
        {running && (
          <div className="space-y-1" role="status" aria-live="polite">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>DuckDB query in progress</span>
              <span>{elapsedLabel}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              aria-label="Query progress"
            >
              <div className="query-progress-indicator h-full w-1/3 rounded-full bg-primary" />
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {queryError && (
        <div className="p-3 bg-destructive/10 text-destructive text-sm">
          {queryError}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b">
            {result.row_count} row{result.row_count !== 1 ? "s" : ""} •{" "}
            {result.execution_time_ms}ms
          </div>
          <div className="flex-1 min-h-0">
            <ResizableResultsTable result={result} />
          </div>
        </div>
      )}

      {!result && !queryError && !running && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Write a query and press Run to see results
        </div>
      )}

      {/* Export Dialog */}
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        sql={sql}
        resultTableName={result?.export_table_name}
      />
    </div>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const roundedSeconds = Math.floor(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
