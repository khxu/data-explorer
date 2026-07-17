import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
import { useAppState } from "@/hooks/useAppState";
import { registerDataSource, assignTags } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function RegisterDataSourceDialog({ open: isOpen, onClose }: Props) {
  const { tags, refreshDataSources } = useAppState();
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    const result = await open({
      multiple: true,
      filters: [
        {
          name: "Data Files",
          extensions: ["parquet", "pq", "csv", "tsv", "json", "jsonl", "ndjson"],
        },
      ],
    });
    if (result) {
      const paths = Array.isArray(result) ? result : [result];
      setFilePaths(paths);
      if (!name) {
        const parts = paths[0].split(/[/\\]/);
        const fileName = parts[parts.length - 1];
        const baseName = fileName.replace(/\.[^.]+$/, "");
        setName(baseName);
      }
    }
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  }

  async function handleSubmit() {
    if (filePaths.length === 0 || !name) return;
    setLoading(true);
    setError(null);
    try {
      const ds = await registerDataSource(name, filePaths);
      if (selectedTagIds.length > 0) {
        await assignTags(ds.id, selectedTagIds);
      }
      await refreshDataSources();
      setFilePaths([]);
      setName("");
      setSelectedTagIds([]);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register Data Source</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>File</Label>
            <div className="flex gap-2">
              <Input
                value={
                  filePaths.length > 1
                    ? `${filePaths.length} files selected`
                    : filePaths[0] ?? ""
                }
                placeholder="Select one or more data files..."
                readOnly
                className="flex-1"
              />
              <Button variant="outline" onClick={pickFile}>
                Browse
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Table Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. users, sales_2024"
            />
          </div>
          {tags.length > 0 && (
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
                    {tag.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={filePaths.length === 0 || !name || loading}>
            {loading ? "Registering..." : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
