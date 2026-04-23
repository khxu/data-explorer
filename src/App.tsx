import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppProvider, useAppState } from "@/hooks/useAppState";
import { Sidebar } from "@/components/Sidebar";
import { QueryEditor } from "@/components/QueryEditor";
import { QueryTabBar } from "@/components/QueryTabBar";
import { HistoryPanel } from "@/components/HistoryPanel";
import "./App.css";

function AppContent() {
  const { error, setError, activeTab, setActiveTab, refreshHistory } = useAppState();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
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
          </TabsList>
          <TabsContent value="query" className="flex-1 min-h-0 mt-0 flex flex-col">
            <QueryTabBar />
            <div className="flex-1 min-h-0">
              <QueryEditor />
            </div>
          </TabsContent>
          <TabsContent value="history" className="flex-1 min-h-0 mt-0">
            <HistoryPanel />
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
