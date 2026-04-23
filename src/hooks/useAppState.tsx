import { useState, useCallback, useEffect, createContext, useContext, type ReactNode } from "react";
import {
  type DataSource,
  type Tag,
  type Project,
  type QueryResult,
  type QueryHistoryEntry,
  listDataSources,
  listTags,
  listProjects,
  getQueryHistory,
} from "@/lib/api";

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
}

let nextTabId = 1;
function makeTab(name?: string, sql?: string): QueryTab {
  const id = `tab-${nextTabId++}`;
  return { id, name: name ?? `Query ${nextTabId - 1}`, sql: sql ?? "", result: null, error: null };
}

interface AppState {
  dataSources: DataSource[];
  tags: Tag[];
  projects: Project[];
  queryHistory: QueryHistoryEntry[];
  activeProject: Project | null;
  activeTab: string;
  queryTabs: QueryTab[];
  activeQueryTabId: string;
  error: string | null;
  refreshDataSources: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  setActiveProject: (p: Project | null) => void;
  setActiveTab: (t: string) => void;
  setError: (e: string | null) => void;
  // Query tab management
  setActiveQueryTab: (id: string) => void;
  addQueryTab: (sql?: string) => void;
  closeQueryTab: (id: string) => void;
  renameQueryTab: (id: string, name: string) => void;
  updateQueryTab: (id: string, updates: Partial<Pick<QueryTab, "sql" | "result" | "error">>) => void;
  /** Convenience: set SQL on the currently active query tab */
  setLastSql: (s: string) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("query");

  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(() => [makeTab()]);
  const [activeQueryTabId, setActiveQueryTabId] = useState(() => queryTabs[0]?.id ?? "");

  const [error, setError] = useState<string | null>(null);

  // Ensure activeQueryTabId always points to an existing tab
  useEffect(() => {
    if (!queryTabs.find((t) => t.id === activeQueryTabId) && queryTabs.length > 0) {
      setActiveQueryTabId(queryTabs[0].id);
    }
  }, [queryTabs, activeQueryTabId]);

  const addQueryTab = useCallback((sql?: string) => {
    const tab = makeTab(undefined, sql);
    setQueryTabs((prev) => [...prev, tab]);
    setActiveQueryTabId(tab.id);
    setActiveTab("query");
  }, []);

  const closeQueryTab = useCallback((id: string) => {
    setQueryTabs((prev) => {
      if (prev.length <= 1) return prev; // don't close the last tab
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  const renameQueryTab = useCallback((id: string, name: string) => {
    setQueryTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  const updateQueryTab = useCallback(
    (id: string, updates: Partial<Pick<QueryTab, "sql" | "result" | "error">>) => {
      setQueryTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)));
    },
    []
  );

  const setLastSql = useCallback(
    (s: string) => {
      setActiveTab("query");
      updateQueryTab(activeQueryTabId, { sql: s });
    },
    [activeQueryTabId, updateQueryTab]
  );

  const refreshDataSources = useCallback(async () => {
    try {
      const tagIds = activeProject?.tag_filter.length
        ? activeProject.tag_filter
        : undefined;
      setDataSources(await listDataSources(tagIds));
    } catch (e) {
      setError(String(e));
    }
  }, [activeProject]);

  const refreshTags = useCallback(async () => {
    try {
      setTags(await listTags());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setQueryHistory(await getQueryHistory());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refreshDataSources();
    refreshTags();
    refreshProjects();
    refreshHistory();
  }, [refreshDataSources, refreshTags, refreshProjects, refreshHistory]);

  return (
    <AppContext.Provider
      value={{
        dataSources,
        tags,
        projects,
        queryHistory,
        activeProject,
        activeTab,
        queryTabs,
        activeQueryTabId,
        error,
        refreshDataSources,
        refreshTags,
        refreshProjects,
        refreshHistory,
        setActiveProject,
        setActiveTab,
        setError,
        setActiveQueryTab: setActiveQueryTabId,
        addQueryTab,
        closeQueryTab,
        renameQueryTab,
        updateQueryTab,
        setLastSql,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within AppProvider");
  return ctx;
}
