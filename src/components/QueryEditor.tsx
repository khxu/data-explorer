import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/hooks/useAppState";
import { executeQuery, getStandaloneSql } from "@/lib/api";
import { ExportDialog } from "./ExportDialog";
import { ResizableResultsTable } from "./ResizableResultsTable";
import { SqlEditor } from "./SqlEditor";

export function QueryEditor() {
  const { queryTabs, activeQueryTabId, updateQueryTab, refreshHistory } =
    useAppState();
  const [running, setRunning] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);

  const tab = queryTabs.find((t) => t.id === activeQueryTabId);
  if (!tab) return null;

  const tabId = tab.id;
  const sql = tab.sql;
  const result = tab.result;
  const queryError = tab.error;

  async function handleRun() {
    if (!sql.trim()) return;
    setRunning(true);
    updateQueryTab(tabId, { error: null });
    try {
      const result = await executeQuery(sql);
      updateQueryTab(tabId, { result });
      await refreshHistory();
    } catch (e) {
      updateQueryTab(tabId, { error: String(e), result: null });
    } finally {
      setRunning(false);
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
              {running ? "Running..." : "▶ Run"}
            </Button>
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
          <div className="flex-1 min-h-0 overflow-auto">
            <ResizableResultsTable result={result} />
          </div>
        </div>
      )}

      {!result && !queryError && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Write a query and press Run to see results
        </div>
      )}

      {/* Export Dialog */}
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        sql={sql}
      />
    </div>
  );
}
