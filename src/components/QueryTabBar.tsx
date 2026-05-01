import { useState, useEffect, useCallback, useMemo } from "react";
import { useAppState } from "@/hooks/useAppState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ALL_QUERY_TAB_PROJECTS,
  UNASSIGNED_QUERY_TAB_PROJECT,
  queryTabMatchesProjectFilter,
} from "@/hooks/useAppState";

export function QueryTabBar() {
  const {
    projects,
    queryTabs,
    activeQueryTabId,
    queryTabProjectFilter,
    setActiveQueryTab,
    setQueryTabProjectFilter,
    addQueryTab,
    closeQueryTab,
    renameQueryTab,
    setQueryTabProject,
    moveUnassignedQueryTabsToProject,
  } = useAppState();
  const activeTab = queryTabs.find((t) => t.id === activeQueryTabId);
  const unassignedTabCount = queryTabs.filter((tab) => tab.projectId === null).length;
  const filteredTabs = useMemo(
    () => queryTabs.filter((tab) => queryTabMatchesProjectFilter(tab, queryTabProjectFilter)),
    [queryTabs, queryTabProjectFilter]
  );
  const activeTabIsVisible =
    !!activeTab && queryTabMatchesProjectFilter(activeTab, queryTabProjectFilter);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );
  const newTabProjectId =
    queryTabProjectFilter === ALL_QUERY_TAB_PROJECTS
      ? undefined
      : queryTabProjectFilter === UNASSIGNED_QUERY_TAB_PROJECT
      ? null
      : queryTabProjectFilter;

  const switchTab = useCallback(
    (direction: -1 | 1) => {
      const idx = filteredTabs.findIndex((t) => t.id === activeQueryTabId);
      if (idx < 0) return;
      const next = idx + direction;
      if (next >= 0 && next < filteredTabs.length) {
        setActiveQueryTab(filteredTabs[next].id);
      }
    },
    [filteredTabs, activeQueryTabId, setActiveQueryTab]
  );

  useEffect(() => {
    if (filteredTabs.length > 0 && !activeTabIsVisible) {
      setActiveQueryTab(filteredTabs[0].id);
    }
  }, [activeTabIsVisible, filteredTabs, setActiveQueryTab]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        switchTab(e.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [switchTab]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  function startRename(id: string, currentName: string) {
    setEditingId(id);
    setEditName(currentName);
  }

  function commitRename() {
    if (editingId && editName.trim()) {
      renameQueryTab(editingId, editName.trim());
    }
    setEditingId(null);
  }

  function handleAddTab() {
    addQueryTab(undefined, newTabProjectId);
  }

  return (
    <div className="border-b bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Query tabs</span>
        <Select value={queryTabProjectFilter} onValueChange={setQueryTabProjectFilter}>
          <SelectTrigger size="sm" className="h-7 min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_QUERY_TAB_PROJECTS}>All projects</SelectItem>
            <SelectItem value={UNASSIGNED_QUERY_TAB_PROJECT}>Unassigned</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeTab && activeTabIsVisible && (
          <>
            <span className="text-xs text-muted-foreground">Active tab project</span>
            <Select
              value={activeTab.projectId ?? UNASSIGNED_QUERY_TAB_PROJECT}
              onValueChange={(value) =>
                setQueryTabProject(
                  activeTab.id,
                  value === UNASSIGNED_QUERY_TAB_PROJECT ? null : value
                )
              }
            >
              <SelectTrigger size="sm" className="h-7 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED_QUERY_TAB_PROJECT}>Unassigned</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {unassignedTabCount > 0 && projects.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground">
              {unassignedTabCount} unassigned
            </span>
            <Select onValueChange={moveUnassignedQueryTabsToProject}>
              <SelectTrigger
                size="sm"
                className="h-7 min-w-40"
                title="Move all unassigned query tabs into a project"
              >
                <SelectValue placeholder="Move unassigned to..." />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>
      <div className="flex items-center gap-0.5 px-3 pt-1 overflow-x-auto">
        {filteredTabs.map((tab) => {
          const isActive = tab.id === activeQueryTabId;
          const isEditing = editingId === tab.id;
          const project = tab.projectId ? projectById.get(tab.projectId) : null;

          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 px-2 py-1 rounded-t text-sm cursor-pointer border border-b-0 ${
                isActive
                  ? "bg-background border-border"
                  : "bg-muted/40 border-transparent hover:bg-muted/60"
              }`}
              onClick={() => setActiveQueryTab(tab.id)}
            >
              {isEditing ? (
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="h-5 w-24 text-xs px-1 py-0"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <TooltipProvider delayDuration={500}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="truncate max-w-[120px] select-none"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startRename(tab.id, tab.name);
                        }}
                      >
                        {tab.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>
                        {project ? `${project.name} • ` : ""}
                        Double-click to rename
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {queryTabProjectFilter === ALL_QUERY_TAB_PROJECTS && project && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  {project.name}
                </Badge>
              )}
              {queryTabs.length > 1 && (
                <button
                  className="ml-1 text-muted-foreground hover:text-destructive text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeQueryTab(tab.id);
                  }}
                  title="Close tab"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {filteredTabs.length === 0 && (
          <span className="text-xs text-muted-foreground px-2 py-1">
            No query tabs in this project
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground"
          onClick={handleAddTab}
          title="New query tab"
        >
          +
        </Button>
      </div>
    </div>
  );
}
