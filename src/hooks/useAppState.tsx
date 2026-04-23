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

interface AppState {
  dataSources: DataSource[];
  tags: Tag[];
  projects: Project[];
  queryHistory: QueryHistoryEntry[];
  activeProject: Project | null;
  activeTab: string;
  lastResult: QueryResult | null;
  lastSql: string;
  error: string | null;
  refreshDataSources: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  setActiveProject: (p: Project | null) => void;
  setActiveTab: (t: string) => void;
  setLastResult: (r: QueryResult | null) => void;
  setLastSql: (s: string) => void;
  setError: (e: string | null) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("query");
  const [lastResult, setLastResult] = useState<QueryResult | null>(null);
  const [lastSql, setLastSql] = useState("");
  const [error, setError] = useState<string | null>(null);

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
        lastResult,
        lastSql,
        error,
        refreshDataSources,
        refreshTags,
        refreshProjects,
        refreshHistory,
        setActiveProject,
        setActiveTab,
        setLastResult,
        setLastSql,
        setError,
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
