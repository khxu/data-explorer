import { useState } from "react";
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
import { useAppState } from "@/hooks/useAppState";
import { createTag, deleteTag } from "@/lib/api";

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TagManagerDialog({ open: isOpen, onClose }: Props) {
  const { tags, refreshTags, refreshDataSources } = useAppState();
  const [newName, setNewName] = useState("");
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0]);
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setLoading(true);
    try {
      await createTag(newName.trim(), selectedColor);
      await refreshTags();
      setNewName("");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteTag(id);
    await refreshTags();
    await refreshDataSources();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Manage Tags</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>New Tag</Label>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tag name"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                className="flex-1"
              />
              <Button onClick={handleCreate} disabled={!newName.trim() || loading} size="sm">
                Add
              </Button>
            </div>
            <div className="flex gap-1">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  className="w-5 h-5 rounded-full border-2 transition-all"
                  style={{
                    backgroundColor: c,
                    borderColor: c === selectedColor ? "white" : "transparent",
                    boxShadow: c === selectedColor ? `0 0 0 2px ${c}` : "none",
                  }}
                  onClick={() => setSelectedColor(c)}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1">
            {tags.map((tag) => (
              <div key={tag.id} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full inline-block"
                    style={{ backgroundColor: tag.color ?? "#888" }}
                  />
                  <span className="text-sm">{tag.name}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(tag.id)}
                >
                  ✕
                </Button>
              </div>
            ))}
            {tags.length === 0 && (
              <p className="text-sm text-muted-foreground">No tags yet</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
