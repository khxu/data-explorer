import { useState } from "react";
import { useAppState } from "@/hooks/useAppState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function QueryTabBar() {
  const {
    queryTabs,
    activeQueryTabId,
    setActiveQueryTab,
    addQueryTab,
    closeQueryTab,
    renameQueryTab,
  } = useAppState();

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

  return (
    <div className="flex items-center gap-0.5 px-3 pt-2 overflow-x-auto">
      {queryTabs.map((tab) => {
        const isActive = tab.id === activeQueryTabId;
        const isEditing = editingId === tab.id;

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
                    <p>Double-click to rename</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground"
        onClick={() => addQueryTab()}
        title="New query tab"
      >
        +
      </Button>
    </div>
  );
}
