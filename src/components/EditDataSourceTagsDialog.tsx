import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useAppState } from "@/hooks/useAppState";
import { assignTags, removeTags, type DataSource } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  dataSource: DataSource | null;
}

export function EditDataSourceTagsDialog({ open: isOpen, onClose, dataSource }: Props) {
  const { tags, refreshDataSources } = useAppState();
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && dataSource) {
      setSelectedTagIds(dataSource.tags ?? []);
    }
  }, [isOpen, dataSource]);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  }

  async function handleSave() {
    if (!dataSource) return;
    setLoading(true);
    try {
      const currentTags = dataSource.tags ?? [];
      const toAdd = selectedTagIds.filter((t) => !currentTags.includes(t));
      const toRemove = currentTags.filter((t) => !selectedTagIds.includes(t));

      if (toAdd.length > 0) {
        await assignTags(dataSource.id, toAdd);
      }
      if (toRemove.length > 0) {
        await removeTags(dataSource.id, toRemove);
      }
      await refreshDataSources();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  if (!dataSource) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="truncate">Edit Tags — {dataSource.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground break-all" title={dataSource.file_path}>
            {dataSource.file_path}
          </p>
          {tags.length > 0 ? (
            <div className="space-y-2">
              <Label>Tags</Label>
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
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No tags exist yet. Create tags first using the ⚙ button in the sidebar.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
