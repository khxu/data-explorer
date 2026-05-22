import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { exportResults } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  sql: string;
  resultTableName?: string | null;
}

export function ExportDialog({ open: isOpen, onClose, sql, resultTableName }: Props) {
  const [format, setFormat] = useState("parquet");
  const [destPath, setDestPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [destinationNotice, setDestinationNotice] = useState<string | null>(null);

  async function pickDestination() {
    const defaultExt = format === "parquet" ? "parquet" : "csv";
    const result = await save({
      filters: [
        {
          name: format === "parquet" ? "Parquet" : "CSV",
          extensions: [defaultExt],
        },
      ],
      defaultPath: `export.${defaultExt}`,
    });
    if (result) {
      setDestPath(result);
      setError(null);
      setSuccess(null);
      setDestinationNotice(`Results will be saved to ${result}`);
    }
  }

  async function handleExport() {
    if (!destPath || !sql) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setDestinationNotice(null);
    try {
      const path = await exportResults(sql, format, destPath, resultTableName);
      setSuccess(`Exported to ${path}`);
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
          <DialogTitle>Export Results</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Format</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parquet">Parquet</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Destination</Label>
            <div className="flex gap-2">
              <Input
                value={destPath}
                placeholder="Choose save location..."
                readOnly
                className="flex-1"
              />
              <Button variant="outline" onClick={pickDestination}>
                Browse
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {destinationNotice && (
            <p className="text-sm text-muted-foreground">{destinationNotice}</p>
          )}
          {success && <p className="text-sm text-green-600">{success}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={!destPath || loading}>
            {loading ? "Exporting..." : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
