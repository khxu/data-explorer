import { useState, useCallback, useEffect, useRef, createContext, useContext, type ReactNode } from "react";
import {
  type DataSource,
  type Tag,
  type Project,
  type QueryResult,
  type QueryHistoryEntry,
  type DataSourceSchema,
  listDataSources,
  getDataSourceSchema,
  listTags,
  listProjects,
  getQueryHistory,
  loadQueryTabs,
  releaseQueryResult,
  saveQueryTabs,
  type SavedQueryTab,
} from "@/lib/api";

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
  projectId: string | null;
  result: QueryResult | null;
  error: string | null;
}

export type QueryTabDropPosition = "before" | "after";

export const ALL_QUERY_TAB_PROJECTS = "__all__";
export const UNASSIGNED_QUERY_TAB_PROJECT = "__unassigned__";

export function queryTabMatchesProjectFilter(tab: QueryTab, filter: string) {
  if (filter === ALL_QUERY_TAB_PROJECTS) return true;
  if (filter === UNASSIGNED_QUERY_TAB_PROJECT) return tab.projectId === null;
  return tab.projectId === filter;
}

let nextTabId = 1;
function makeTab(name?: string, sql?: string, projectId: string | null = null): QueryTab {
  const id = `tab-${nextTabId++}`;
  return {
    id,
    name: name ?? `Query ${nextTabId - 1}`,
    sql: sql ?? "",
    projectId,
    result: null,
    error: null,
  };
}

interface AppState {
  dataSources: DataSource[];
  dataSourceSchemas: DataSourceSchema[];
  tags: Tag[];
  projects: Project[];
  queryHistory: QueryHistoryEntry[];
  activeProject: Project | null;
  activeTab: string;
  queryTabs: QueryTab[];
  activeQueryTabId: string;
  queryTabProjectFilter: string;
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
  setQueryTabProjectFilter: (projectId: string) => void;
  addQueryTab: (sql?: string, projectId?: string | null) => void;
  closeQueryTab: (id: string) => void;
  renameQueryTab: (id: string, name: string) => void;
  reorderQueryTab: (draggedId: string, targetId: string, position: QueryTabDropPosition) => void;
  setQueryTabProject: (id: string, projectId: string | null) => void;
  moveUnassignedQueryTabsToProject: (projectId: string) => void;
  clearQueryTabProject: (projectId: string) => void;
  updateQueryTab: (id: string, updates: Partial<Pick<QueryTab, "sql" | "result" | "error">>) => void;
  /** Convenience: set SQL on the currently active query tab */
  setLastSql: (s: string) => void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [dataSourceSchemas, setDataSourceSchemas] = useState<DataSourceSchema[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("query");

  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(() => [makeTab()]);
  const [activeQueryTabId, setActiveQueryTabId] = useState(() => queryTabs[0]?.id ?? "");
  const [queryTabProjectFilter, setQueryTabProjectFilter] = useState(ALL_QUERY_TAB_PROJECTS);
  const tabsLoaded = useRef(false);

  const [error, setError] = useState<string | null>(null);

  // Load persisted tabs on startup
  useEffect(() => {
    loadQueryTabs().then((saved) => {
      if (saved.length > 0) {
        const tabs = saved.map((s) => ({
          id: s.id,
          name: s.name,
          sql: s.sql_text,
          projectId: s.project_id,
          result: null,
          error: null,
        }));
        // Restore the nextTabId counter past any saved IDs
        const maxNum = saved.reduce((max, s) => {
          const n = parseInt(s.id.replace("tab-", ""), 10);
          return isNaN(n) ? max : Math.max(max, n);
        }, 0);
        nextTabId = maxNum + 1;

        setQueryTabs(tabs);
        const activeOne = saved.find((s) => s.is_active);
        setActiveQueryTabId(activeOne ? activeOne.id : tabs[0].id);
      }
      tabsLoaded.current = true;
    }).catch(() => {
      tabsLoaded.current = true;
    });
  }, []);

  // Debounce-save tabs whenever they change
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!tabsLoaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const toSave: SavedQueryTab[] = queryTabs.map((t, i) => ({
        id: t.id,
        name: t.name,
        sql_text: t.sql,
        project_id: t.projectId,
        sort_order: i,
        is_active: t.id === activeQueryTabId,
      }));
      saveQueryTabs(toSave).catch(() => {});
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [queryTabs, activeQueryTabId]);

  // Ensure activeQueryTabId always points to an existing tab
  useEffect(() => {
    if (!queryTabs.find((t) => t.id === activeQueryTabId) && queryTabs.length > 0) {
      setActiveQueryTabId(queryTabs[0].id);
    }
  }, [queryTabs, activeQueryTabId]);

  useEffect(() => {
    if (
      queryTabProjectFilter !== ALL_QUERY_TAB_PROJECTS &&
      queryTabProjectFilter !== UNASSIGNED_QUERY_TAB_PROJECT &&
      !projects.some((project) => project.id === queryTabProjectFilter)
    ) {
      setQueryTabProjectFilter(ALL_QUERY_TAB_PROJECTS);
    }
  }, [projects, queryTabProjectFilter]);

  const addQueryTab = useCallback((sql?: string, projectId?: string | null) => {
    const defaultProjectId =
      queryTabProjectFilter === UNASSIGNED_QUERY_TAB_PROJECT
        ? null
        : queryTabProjectFilter !== ALL_QUERY_TAB_PROJECTS
        ? queryTabProjectFilter
        : activeProject?.id ?? null;
    const tab = makeTab(
      undefined,
      sql,
      projectId !== undefined ? projectId : defaultProjectId
    );
    setQueryTabs((prev) => [...prev, tab]);
    setActiveQueryTabId(tab.id);
    setActiveTab("query");
  }, [activeProject, queryTabProjectFilter]);

  const closeQueryTab = useCallback((id: string) => {
    const tab = queryTabs.find((t) => t.id === id);
    if (queryTabs.length <= 1) return;
    if (tab?.result?.export_table_name) {
      releaseQueryResult(tab.result.export_table_name).catch(() => {});
    }
    setQueryTabs((prev) => {
      if (prev.length <= 1) return prev; // don't close the last tab
      return prev.filter((t) => t.id !== id);
    });
  }, [queryTabs]);

  const renameQueryTab = useCallback((id: string, name: string) => {
    setQueryTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  const reorderQueryTab = useCallback(
    (draggedId: string, targetId: string, position: QueryTabDropPosition) => {
      if (draggedId === targetId) return;

      setQueryTabs((prev) => {
        const draggedTab = prev.find((tab) => tab.id === draggedId);
        if (!draggedTab) return prev;

        const withoutDragged = prev.filter((tab) => tab.id !== draggedId);
        const targetIndex = withoutDragged.findIndex((tab) => tab.id === targetId);
        if (targetIndex < 0) return prev;

        const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
        return [
          ...withoutDragged.slice(0, insertIndex),
          draggedTab,
          ...withoutDragged.slice(insertIndex),
        ];
      });
    },
    []
  );

  const setQueryTabProject = useCallback((id: string, projectId: string | null) => {
    setQueryTabs((prev) => prev.map((t) => (t.id === id ? { ...t, projectId } : t)));
  }, []);

  const moveUnassignedQueryTabsToProject = useCallback((projectId: string) => {
    setQueryTabs((prev) =>
      prev.map((t) => (t.projectId === null ? { ...t, projectId } : t))
    );
    setQueryTabProjectFilter(projectId);
  }, []);

  const clearQueryTabProject = useCallback((projectId: string) => {
    setQueryTabs((prev) =>
      prev.map((t) => (t.projectId === projectId ? { ...t, projectId: null } : t))
    );
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
      const activeQueryTab = queryTabs.find((t) => t.id === activeQueryTabId);
      if (
        activeQueryTab &&
        queryTabMatchesProjectFilter(activeQueryTab, queryTabProjectFilter)
      ) {
        updateQueryTab(activeQueryTabId, { sql: s });
        return;
      }
      addQueryTab(s);
    },
    [activeQueryTabId, addQueryTab, queryTabProjectFilter, queryTabs, updateQueryTab]
  );

  const refreshDataSources = useCallback(async () => {
    try {
      const tagIds = activeProject?.tag_filter.length
        ? activeProject.tag_filter
        : undefined;
      const sources = await listDataSources(tagIds);
      const schemas = await Promise.all(
        sources.map((source) => getDataSourceSchema(source.id))
      );
      setDataSources(sources);
      setDataSourceSchemas(schemas);
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
        dataSourceSchemas,
        tags,
        projects,
        queryHistory,
        activeProject,
        activeTab,
        queryTabs,
        activeQueryTabId,
        queryTabProjectFilter,
        error,
        refreshDataSources,
        refreshTags,
        refreshProjects,
        refreshHistory,
        setActiveProject,
        setActiveTab,
        setError,
        setActiveQueryTab: setActiveQueryTabId,
        setQueryTabProjectFilter,
        addQueryTab,
        closeQueryTab,
        renameQueryTab,
        reorderQueryTab,
        setQueryTabProject,
        moveUnassignedQueryTabsToProject,
        clearQueryTabProject,
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
