import { useCallback, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppProvider, useAppState } from "@/hooks/useAppState";
import { usePersistedNumber } from "@/hooks/usePersistedNumber";
import { Sidebar } from "@/components/Sidebar";
import { QueryEditor } from "@/components/QueryEditor";
import { QueryTabBar } from "@/components/QueryTabBar";
import { HistoryPanel } from "@/components/HistoryPanel";
import { LlmRunsPanel } from "@/components/LlmRunsPanel";
import "./App.css";

const SIDEBAR_WIDTH_STORAGE_KEY = "data-explorer.sidebarWidth";
const SIDEBAR_WIDTH_BOUNDS = { min: 180, max: 600 };
const DEFAULT_SIDEBAR_WIDTH = 256;
const QUERY_TABS_WIDTH_STORAGE_KEY = "data-explorer.queryTabsWidth";
const QUERY_TABS_WIDTH_BOUNDS = { min: 180, max: 480 };
const DEFAULT_QUERY_TABS_WIDTH = 240;

function AppContent() {
  const { error, setError, activeTab, setActiveTab, refreshHistory } = useAppState();
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber(
    SIDEBAR_WIDTH_STORAGE_KEY,
    DEFAULT_SIDEBAR_WIDTH,
    SIDEBAR_WIDTH_BOUNDS
  );
  const [queryTabsWidth, setQueryTabsWidth] = usePersistedNumber(
    QUERY_TABS_WIDTH_STORAGE_KEY,
    DEFAULT_QUERY_TABS_WIDTH,
    QUERY_TABS_WIDTH_BOUNDS
  );
  const isResizingSidebar = useRef(false);
  const isResizingQueryTabs = useRef(false);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSidebar.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingSidebar.current) return;
      const newWidth = Math.min(
        Math.max(ev.clientX, SIDEBAR_WIDTH_BOUNDS.min),
        SIDEBAR_WIDTH_BOUNDS.max
      );
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingSidebar.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [setSidebarWidth]);

  const handleQueryTabsMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingQueryTabs.current = true;
    const startX = e.clientX;
    const startWidth = queryTabsWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingQueryTabs.current) return;
      setQueryTabsWidth(startWidth + ev.clientX - startX);
    };

    const onMouseUp = () => {
      isResizingQueryTabs.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [queryTabsWidth, setQueryTabsWidth]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div
        style={{
          width: sidebarWidth,
          minWidth: SIDEBAR_WIDTH_BOUNDS.min,
          maxWidth: SIDEBAR_WIDTH_BOUNDS.max,
        }}
        className="flex-shrink-0"
      >
        <Sidebar />
      </div>
      <div
        className="w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0"
        onMouseDown={handleSidebarMouseDown}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {/* Error banner */}
        {error && (
          <div className="bg-destructive/10 text-destructive text-sm px-3 py-2 flex items-center justify-between">
            <span>{error}</span>
            <button
              className="text-xs underline ml-2"
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v) => {
          setActiveTab(v);
          if (v === "history") refreshHistory();
        }} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-3 mt-2 w-fit">
            <TabsTrigger value="query">Query</TabsTrigger>
            <TabsTrigger value="history">
              History
            </TabsTrigger>
            <TabsTrigger value="llm-runs">LLM Runs</TabsTrigger>
          </TabsList>
          <TabsContent value="query" className="flex-1 min-h-0 mt-0 flex">
            <div
              style={{
                width: queryTabsWidth,
                minWidth: QUERY_TABS_WIDTH_BOUNDS.min,
                maxWidth: QUERY_TABS_WIDTH_BOUNDS.max,
              }}
              className="shrink-0"
            >
              <QueryTabBar />
            </div>
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/30 active:bg-primary/50"
              onMouseDown={handleQueryTabsMouseDown}
              title="Resize query tabs sidebar"
            />
            <div className="flex-1 min-h-0 min-w-0">
              <QueryEditor />
            </div>
          </TabsContent>
          <TabsContent value="history" className="flex-1 min-h-0 mt-0">
            <HistoryPanel />
          </TabsContent>
          <TabsContent value="llm-runs" className="flex-1 min-h-0 mt-0">
            <LlmRunsPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
