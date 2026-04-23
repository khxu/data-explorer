import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAppState } from "@/hooks/useAppState";
import { clearQueryHistory } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function HistoryPanel() {
  const { queryHistory, setLastSql, setActiveTab, refreshHistory } = useAppState();
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearMode, setClearMode] = useState<"all" | "before">("all");
  const [beforeDate, setBeforeDate] = useState("");

  async function handleClear() {
    try {
      if (clearMode === "all") {
        await clearQueryHistory();
      } else if (beforeDate) {
        // Convert local date input to ISO string for SQLite comparison
        await clearQueryHistory(new Date(beforeDate).toISOString());
      }
      setShowClearDialog(false);
      setBeforeDate("");
      await refreshHistory();
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold">Query History</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => {
              setClearMode("before");
              setShowClearDialog(true);
            }}
          >
            Clear before…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-destructive hover:text-destructive"
            onClick={() => {
              setClearMode("all");
              setShowClearDialog(true);
            }}
          >
            Clear All
          </Button>
          <Button variant="ghost" size="sm" onClick={refreshHistory}>
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-3 space-y-2">
          {queryHistory.map((entry) => (
            <div
              key={entry.id}
              className="border rounded-lg p-3 space-y-1 hover:bg-accent/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={entry.status === "success" ? "default" : "destructive"}
                    className="text-xs"
                  >
                    {entry.status}
                  </Badge>
                  {entry.row_count != null && (
                    <span className="text-xs text-muted-foreground">
                      {entry.row_count} rows
                    </span>
                  )}
                  {entry.execution_time_ms != null && (
                    <span className="text-xs text-muted-foreground">
                      {entry.execution_time_ms}ms
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => {
                      setLastSql(entry.sql_text);
                      setActiveTab("query");
                    }}
                  >
                    Reuse
                  </Button>
                </div>
              </div>
              <pre className="text-xs font-mono bg-muted/50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                {entry.sql_text}
              </pre>
              {entry.error_message && (
                <p className="text-xs text-destructive">{entry.error_message}</p>
              )}
            </div>
          ))}
          {queryHistory.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No queries yet
            </p>
          )}
        </div>
      </div>

      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {clearMode === "all" ? "Clear All History" : "Clear History Before Date"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {clearMode === "all"
                ? "This will permanently delete all query history entries. This cannot be undone."
                : "Delete all query history entries before the selected date."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {clearMode === "before" && (
            <div className="py-2">
              <input
                type="date"
                value={beforeDate}
                onChange={(e) => setBeforeDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              disabled={clearMode === "before" && !beforeDate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearMode === "all" ? "Clear All" : "Clear"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
