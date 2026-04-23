import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useAppState } from "@/hooks/useAppState";
import { createProject, updateProject, type Project } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  editProject?: Project | null;
}

export function ProjectDialog({ open: isOpen, onClose, editProject }: Props) {
  const { tags, refreshProjects } = useAppState();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Reset form state when the dialog opens or the project changes
  useEffect(() => {
    if (isOpen) {
      setName(editProject?.name ?? "");
      setDescription(editProject?.description ?? "");
      setSelectedTagIds(editProject?.tag_filter ?? []);
    }
  }, [isOpen, editProject]);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    setLoading(true);
    try {
      if (editProject) {
        await updateProject(
          editProject.id,
          name.trim(),
          description || null,
          selectedTagIds
        );
      } else {
        await createProject(name.trim(), description || null, selectedTagIds);
      }
      await refreshProjects();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editProject ? "Edit Project" : "New Project"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={2}
            />
          </div>
          {tags.length > 0 && (
            <div className="space-y-2">
              <Label>Filter by Tags</Label>
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge
                    key={tag.id}
                    variant={selectedTagIds.includes(tag.id) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleTag(tag.id)}
                  >
                    <span
                      className="w-2 h-2 rounded-full inline-block mr-1"
                      style={{ backgroundColor: tag.color ?? "#888" }}
                    />
                    {tag.name}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Sources matching any selected tag will appear in this project
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || loading}>
            {loading ? "Saving..." : editProject ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
