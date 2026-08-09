import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ALL_QUERY_TAB_PROJECTS,
  UNASSIGNED_QUERY_TAB_PROJECT,
  queryTabMatchesProjectFilter,
  type QueryTabDropPosition,
} from "@/hooks/useAppState";

interface DropTarget {
  id: string;
  position: QueryTabDropPosition;
}

interface PointerDragState {
  id: string;
  startX: number;
  startY: number;
  isDragging: boolean;
}

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
    reorderQueryTab,
    setQueryTabProject,
    moveUnassignedQueryTabsToProject,
  } = useAppState();
  const unassignedTabCount = queryTabs.filter((tab) => tab.projectId === null).length;
  const filteredTabs = useMemo(
    () => queryTabs.filter((tab) => queryTabMatchesProjectFilter(tab, queryTabProjectFilter)),
    [queryTabs, queryTabProjectFilter]
  );
  const activeTab = queryTabs.find((t) => t.id === activeQueryTabId);
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
      if (
        e.metaKey &&
        e.altKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        e.preventDefault();
        switchTab(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [switchTab]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const suppressClickRef = useRef(false);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeQueryTabId]);

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

  function getPointerDropTarget(clientX: number, clientY: number): DropTarget | null {
    const tabElement = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-query-tab-id]");
    if (!tabElement?.dataset.queryTabId) return null;

    const rect = tabElement.getBoundingClientRect();
    return {
      id: tabElement.dataset.queryTabId,
      position: clientY < rect.top + rect.height / 2 ? "before" : "after",
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>, tabId: string) {
    if (e.button !== 0) return;

    pointerDragRef.current = {
      id: tabId,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = pointerDragRef.current;
    if (!dragState) return;

    const distanceX = Math.abs(e.clientX - dragState.startX);
    const distanceY = Math.abs(e.clientY - dragState.startY);
    if (!dragState.isDragging && distanceX < 4 && distanceY < 4) return;

    dragState.isDragging = true;
    setDraggingTabId(dragState.id);
    const target = getPointerDropTarget(e.clientX, e.clientY);
    setDropTarget(target && target.id !== dragState.id ? target : null);
    e.preventDefault();
  }

  function clearPointerDragState() {
    pointerDragRef.current = null;
    setDraggingTabId(null);
    setDropTarget(null);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const dragState = pointerDragRef.current;
    if (!dragState) return;

    const target = getPointerDropTarget(e.clientX, e.clientY);
    const shouldReorder = dragState.isDragging && target && target.id !== dragState.id;
    clearPointerDragState();

    if (shouldReorder) {
      suppressClickRef.current = true;
      reorderQueryTab(dragState.id, target.id, target.position);
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      e.preventDefault();
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-r bg-muted/20">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Query tabs</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
            onClick={handleAddTab}
            title="New query tab"
          >
            +
          </Button>
        </div>
        <Select value={queryTabProjectFilter} onValueChange={setQueryTabProjectFilter}>
          <SelectTrigger size="sm" className="h-7 w-full">
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
        {unassignedTabCount > 0 && projects.length > 0 && (
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">
              {unassignedTabCount} unassigned
            </span>
            <Select onValueChange={moveUnassignedQueryTabsToProject}>
              <SelectTrigger
                size="sm"
                className="h-7 w-full"
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
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto p-2">
        {filteredTabs.map((tab) => {
          const isActive = tab.id === activeQueryTabId;
          const isEditing = editingId === tab.id;
          const project = tab.projectId ? projectById.get(tab.projectId) : null;
          const isDragging = draggingTabId === tab.id;
          const isDropTarget = dropTarget?.id === tab.id && draggingTabId !== tab.id;

          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  ref={isActive ? activeTabRef : undefined}
                  data-query-tab-id={tab.id}
                  aria-grabbed={isDragging}
                  className={`group flex w-full min-w-0 shrink-0 items-center gap-1 rounded-md border px-2 py-1.5 text-sm cursor-pointer transition-opacity ${
                    isActive
                      ? "bg-background border-border shadow-sm"
                      : "bg-muted/40 border-transparent hover:bg-muted/60"
                  } ${isDragging ? "opacity-50" : ""} ${
                    isDropTarget && dropTarget.position === "before"
                      ? "border-t-2 border-t-primary"
                      : ""
                  } ${
                    isDropTarget && dropTarget.position === "after"
                      ? "border-b-2 border-b-primary"
                      : ""
                  }`}
                  onClick={() => {
                    if (suppressClickRef.current) return;
                    setActiveQueryTab(tab.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    clearPointerDragState();
                    startRename(tab.id, tab.name);
                  }}
                  onPointerDown={(e) => {
                    if (!isEditing) handlePointerDown(e, tab.id);
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={clearPointerDragState}
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
                      className="h-5 min-w-0 flex-1 px-1 py-0 text-xs"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : draggingTabId ? (
                    <span className="min-w-0 flex-1 truncate select-none">
                      {tab.name}
                    </span>
                  ) : (
                    <TooltipProvider delayDuration={500}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="min-w-0 flex-1 truncate select-none">
                            {tab.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p>
                            {project ? `${project.name} • ` : ""}
                            Drag to reorder • Double-click to rename • Right-click for actions
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {queryTabProjectFilter === ALL_QUERY_TAB_PROJECTS && project && (
                    <Badge
                      variant="outline"
                      className="h-4 max-w-20 shrink-0 truncate px-1 text-[10px]"
                    >
                      {project.name}
                    </Badge>
                  )}
                  {queryTabs.length > 1 && (
                    <button
                      className="ml-1 shrink-0 text-muted-foreground hover:text-destructive text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                      onPointerDown={(e) => e.stopPropagation()}
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
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuLabel className="truncate">{tab.name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuSub>
                  <ContextMenuSubTrigger>Assign to project</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                    <ContextMenuRadioGroup
                      value={tab.projectId ?? UNASSIGNED_QUERY_TAB_PROJECT}
                      onValueChange={(value) => {
                        setQueryTabProject(
                          tab.id,
                          value === UNASSIGNED_QUERY_TAB_PROJECT ? null : value
                        );
                      }}
                    >
                      <ContextMenuRadioItem value={UNASSIGNED_QUERY_TAB_PROJECT}>
                        Unassigned
                      </ContextMenuRadioItem>
                      {projects.map((project) => (
                        <ContextMenuRadioItem key={project.id} value={project.id}>
                          {project.name}
                        </ContextMenuRadioItem>
                      ))}
                    </ContextMenuRadioGroup>
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem
                  onSelect={() => {
                    clearPointerDragState();
                    startRename(tab.id, tab.name);
                  }}
                >
                  Rename
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  disabled={queryTabs.length <= 1}
                  onSelect={() => closeQueryTab(tab.id)}
                >
                  Close tab
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {filteredTabs.length === 0 && (
          <span className="px-2 py-1 text-xs text-muted-foreground">
            No query tabs in this project
          </span>
        )}
      </div>
    </div>
  );
}
