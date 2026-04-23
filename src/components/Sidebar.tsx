import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { useAppState } from "@/hooks/useAppState";
import { removeDataSource, deleteProject, refreshDataSource as apiRefreshDataSource, refreshAllDataSources as apiRefreshAllDataSources, type DataSource, type Project } from "@/lib/api";
import { RegisterDataSourceDialog } from "./RegisterDataSourceDialog";
import { TagManagerDialog } from "./TagManagerDialog";
import { ProjectDialog } from "./ProjectDialog";
import { EditDataSourceTagsDialog } from "./EditDataSourceTagsDialog";

const FORMAT_ICONS: Record<string, string> = {
  parquet: "📦",
  csv: "📄",
  json: "📋",
  ndjson: "📋",
  jsonl: "📋",
};

export function Sidebar() {
  const {
    dataSources,
    tags,
    projects,
    activeProject,
    setActiveProject,
    refreshDataSources,
    refreshProjects,
    setLastSql,
  } = useAppState();

  const [showRegister, setShowRegister] = useState(false);
  const [showTagManager, setShowTagManager] = useState(false);
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingDataSource, setEditingDataSource] = useState<DataSource | null>(null);
  const [removingDataSource, setRemovingDataSource] = useState<DataSource | null>(null);

  async function handleConfirmRemoveSource() {
    if (!removingDataSource) return;
    await removeDataSource(removingDataSource.id);
    await refreshDataSources();
    setRemovingDataSource(null);
  }

  async function handleRefreshSource(id: string) {
    try {
      await apiRefreshDataSource(id);
    } catch (e) {
      console.error("Failed to refresh data source:", e);
    }
  }

  async function handleRefreshAll() {
    try {
      await apiRefreshAllDataSources();
    } catch (e) {
      console.error("Failed to refresh all data sources:", e);
    }
  }

  async function handleDeleteProject(id: string) {
    await deleteProject(id);
    await refreshProjects();
    if (activeProject?.id === id) {
      setActiveProject(null);
    }
  }

  function handleSourceClick(name: string) {
    setLastSql(`SELECT * FROM ${name} LIMIT 100`);
  }

  return (
    <div className="w-64 border-r bg-muted/30 flex flex-col h-full">
      {/* Projects */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            Projects
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setShowProjectDialog(true)}
          >
            +
          </Button>
        </div>
        <div className="space-y-0.5">
          <button
            className={`w-full text-left text-sm px-2 py-1 rounded ${
              !activeProject ? "bg-accent" : "hover:bg-accent/50"
            }`}
            onClick={() => setActiveProject(null)}
          >
            All Sources
          </button>
          {projects.map((p) => (
            <div key={p.id} className="flex items-center group">
              <button
                className={`flex-1 text-left text-sm px-2 py-1 rounded truncate ${
                  activeProject?.id === p.id ? "bg-accent" : "hover:bg-accent/50"
                }`}
                onClick={() => setActiveProject(p)}
              >
                {p.name}
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground"
                onClick={() => {
                  setEditingProject(p);
                  setShowProjectDialog(true);
                }}
                title="Edit project"
              >
                ✎
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteProject(p.id)}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      {/* Tags */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            Tags
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setShowTagManager(true)}
          >
            ⚙
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag.id} variant="outline" className="text-xs">
              <span
                className="w-2 h-2 rounded-full inline-block mr-1"
                style={{ backgroundColor: tag.color ?? "#888" }}
              />
              {tag.name}
            </Badge>
          ))}
          {tags.length === 0 && (
            <p className="text-xs text-muted-foreground">No tags</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Data Sources */}
      <div className="p-3 flex-1 min-h-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            Data Sources
          </h3>
          <div className="flex gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={handleRefreshAll}
              title="Refresh all data from disk"
            >
              ↻
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => setShowRegister(true)}
            >
              +
            </Button>
          </div>
        </div>
        <div className="overflow-y-auto h-full">
          <div className="space-y-0.5">
            {dataSources.map((ds) => (
              <div key={ds.id} className="flex items-center group">
                <button
                  className="flex-1 min-w-0 text-left text-sm px-2 py-1 rounded hover:bg-accent/50 truncate"
                  onClick={() => handleSourceClick(ds.name)}
                  title={ds.file_path}
                >
                  <span className="mr-1">
                    {FORMAT_ICONS[ds.file_format] ?? "📁"}
                  </span>
                  {ds.name}
                </button>
                <div className="flex-shrink-0 flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-muted-foreground"
                    onClick={() => handleRefreshSource(ds.id)}
                    title="Refresh data from disk"
                  >
                    ↻
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-muted-foreground"
                    onClick={() => setEditingDataSource(ds)}
                    title="Edit tags"
                  >
                    🏷
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setRemovingDataSource(ds)}
                    title="Unregister data source"
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
            {dataSources.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">
                No data sources registered
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <RegisterDataSourceDialog
        open={showRegister}
        onClose={() => setShowRegister(false)}
      />
      <TagManagerDialog
        open={showTagManager}
        onClose={() => setShowTagManager(false)}
      />
      <ProjectDialog
        open={showProjectDialog}
        onClose={() => {
          setShowProjectDialog(false);
          setEditingProject(null);
        }}
        editProject={editingProject}
      />
      <EditDataSourceTagsDialog
        open={!!editingDataSource}
        onClose={() => setEditingDataSource(null)}
        dataSource={editingDataSource}
      />
      <AlertDialog open={!!removingDataSource} onOpenChange={(open) => { if (!open) setRemovingDataSource(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unregister data source</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to unregister{" "}
              <span className="font-semibold">{removingDataSource?.name}</span>?
              This removes it from Data Explorer but does not delete the original
              file on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRemoveSource}>
              Unregister
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
