import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useAppState } from "@/hooks/useAppState";

export function HistoryPanel() {
  const { queryHistory, setLastSql, setActiveTab, refreshHistory } = useAppState();

  // Refresh on mount/tab switch
  // Parent calls refreshHistory when switching to this tab

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold">Query History</h3>
        <Button variant="ghost" size="sm" onClick={refreshHistory}>
          Refresh
        </Button>
      </div>
      <ScrollArea className="flex-1">
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
      </ScrollArea>
    </div>
  );
}
