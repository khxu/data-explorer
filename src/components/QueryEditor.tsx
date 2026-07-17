import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppState } from "@/hooks/useAppState";
import { cancelQuery, executeQuery, getStandaloneSql, releaseQueryResult, type QueryResult } from "@/lib/api";
import { formatQueryCellValue, hasDuckDbTimestampValues, isNumericColumnType } from "@/lib/utils";
import { AiSqlAssistant } from "./AiSqlAssistant";
import { ExportDialog } from "./ExportDialog";
import { QueryResultsChart } from "./QueryResultsChart";
import { ResizableResultsTable } from "./ResizableResultsTable";
import { SqlEditor } from "./SqlEditor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ALL_QUERY_TAB_PROJECTS,
  UNASSIGNED_QUERY_TAB_PROJECT,
  queryTabMatchesProjectFilter,
} from "@/hooks/useAppState";

export function QueryEditor() {
  const {
    dataSources,
    dataSourceSchemas,
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
  const [showAssistant, setShowAssistant] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [renderTimestampsAsIso, setRenderTimestampsAsIso] = useState(false);

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
  const resultRestored = tab.resultRestored;
  const elapsedLabel = formatElapsed(elapsedMs);
  const hasTimestampValues = result ? hasDuckDbTimestampValues(result) : false;

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

  async function handleCopyMarkdownTable() {
    if (!result) return;

    try {
      await navigator.clipboard.writeText(formatMarkdownTable(result, renderTimestampsAsIso));
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 2000);
    } catch (e) {
      console.error("Failed to copy markdown table:", e);
    }
  }

  return (
    <div className="flex h-full min-w-0">
      <div className="flex flex-col h-full min-w-0 flex-1">
        {/* SQL Editor */}
        <div className="p-3 border-b space-y-2">
          <SqlEditor
            key={tabId}
            value={sql}
            dataSourceSchemas={dataSourceSchemas}
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
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowExport(true)}
                  >
                    Export
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyMarkdownTable}
                    disabled={result.columns.length === 0}
                    title="Copy results to clipboard as a markdown table"
                  >
                    {copiedMarkdown ? "✓ Copied" : "Copy as markdown table"}
                  </Button>
                </>
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
              <Button
                variant={showAssistant ? "default" : "outline"}
                size="sm"
                onClick={() => setShowAssistant((value) => !value)}
              >
                AI Assist
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
            <Tabs defaultValue="table" className="min-h-0 flex-1 gap-0">
              <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {result.row_count} row{result.row_count !== 1 ? "s" : ""} •{" "}
                    {result.execution_time_ms}ms
                  </span>
                  {resultRestored && (
                    <Badge variant="secondary">
                      Restored from cache
                      {result.row_count > result.rows.length
                        ? ` • showing first ${result.rows.length} rows`
                        : ""}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {hasTimestampValues && (
                    <Button
                      type="button"
                      variant={renderTimestampsAsIso ? "default" : "outline"}
                      size="sm"
                      onClick={() => setRenderTimestampsAsIso((value) => !value)}
                      title="Render DuckDB timestamp values as ISO 8601 strings"
                    >
                      ISO timestamps
                    </Button>
                  )}
                  <TabsList>
                    <TabsTrigger value="table">Table</TabsTrigger>
                    <TabsTrigger value="chart">Chart</TabsTrigger>
                  </TabsList>
                </div>
              </div>
              <TabsContent value="table" className="min-h-0 flex-1">
                <ResizableResultsTable
                  result={result}
                  renderTimestampsAsIso={renderTimestampsAsIso}
                />
              </TabsContent>
              <TabsContent value="chart" className="min-h-0 flex-1">
                <QueryResultsChart result={result} />
              </TabsContent>
            </Tabs>
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
      {showAssistant && (
        <AiSqlAssistant
          currentSql={sql}
          dataSources={dataSources}
          onApplySql={(draftSql) => updateQueryTab(tabId, { sql: draftSql })}
          onClose={() => setShowAssistant(false)}
        />
      )}
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

function formatMarkdownTable(result: QueryResult, renderTimestampsAsIso: boolean) {
  const header = result.columns.map(formatMarkdownTableCell).join(" | ");
  const separator = result.columns
    .map((_, index) => (isNumericColumnType(result.column_types[index]) ? "---:" : "---"))
    .join(" | ");
  const rows = result.rows.map((row) =>
    result.columns
      .map((_, index) =>
        formatMarkdownTableCell(
          formatQueryCellValue(row[index], result.column_types[index], {
            renderTimestampsAsIso,
            formatValue: formatMarkdownRawCellValue,
          })
        )
      )
      .join(" | ")
  );

  return [`| ${header} |`, `| ${separator} |`, ...rows.map((row) => `| ${row} |`)].join("\n");
}

function formatMarkdownTableCell(value: unknown) {
  if (value === null || value === undefined) return "";

  return formatMarkdownRawCellValue(value).replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function formatMarkdownRawCellValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}
