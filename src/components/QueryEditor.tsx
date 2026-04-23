import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppState } from "@/hooks/useAppState";
import { executeQuery } from "@/lib/api";
import { ExportDialog } from "./ExportDialog";
import { ResizableResultsTable } from "./ResizableResultsTable";

export function QueryEditor() {
  const { lastSql, setLastSql, lastResult, setLastResult, refreshHistory } =
    useAppState();
  const [running, setRunning] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  async function handleRun() {
    if (!lastSql.trim()) return;
    setRunning(true);
    setQueryError(null);
    try {
      const result = await executeQuery(lastSql);
      setLastResult(result);
      await refreshHistory();
    } catch (e) {
      setQueryError(String(e));
      setLastResult(null);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleRun();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* SQL Editor */}
      <div className="p-3 border-b space-y-2">
        <Textarea
          value={lastSql}
          onChange={(e) => setLastSql(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="SELECT * FROM your_table LIMIT 100"
          className="font-mono text-sm min-h-[100px] resize-y"
          rows={4}
        />
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleRun} disabled={running || !lastSql.trim()} size="sm">
              {running ? "Running..." : "▶ Run"}
            </Button>
            {lastResult && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowExport(true)}
              >
                Export
              </Button>
            )}
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
      {lastResult && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 text-xs text-muted-foreground border-b">
            {lastResult.row_count} row{lastResult.row_count !== 1 ? "s" : ""} •{" "}
            {lastResult.execution_time_ms}ms
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <ResizableResultsTable result={lastResult} />
          </div>
        </div>
      )}

      {!lastResult && !queryError && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Write a query and press Run to see results
        </div>
      )}

      {/* Export Dialog */}
      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        sql={lastSql}
      />
    </div>
  );
}
