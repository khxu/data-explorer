import { useState, useRef, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { QueryResult } from "@/lib/api";

interface Props {
  result: QueryResult;
}

const DEFAULT_COL_WIDTH = 150;
const MIN_COL_WIDTH = 60;

export function ResizableResultsTable({ result }: Props) {
  const [columnWidths, setColumnWidths] = useState<number[]>(() =>
    result.columns.map(() => DEFAULT_COL_WIDTH)
  );
  const [inspectedCell, setInspectedCell] = useState<{
    column: string;
    value: string;
  } | null>(null);

  const resizing = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, colIndex: number) => {
      e.preventDefault();
      resizing.current = {
        index: colIndex,
        startX: e.clientX,
        startWidth: columnWidths[colIndex],
      };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizing.current) return;
        const diff = ev.clientX - resizing.current.startX;
        const newWidth = Math.max(MIN_COL_WIDTH, resizing.current.startWidth + diff);
        setColumnWidths((prev) => {
          const next = [...prev];
          next[resizing.current!.index] = newWidth;
          return next;
        });
      };

      const handleMouseUp = () => {
        resizing.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnWidths]
  );

  // Reset widths when columns change
  if (columnWidths.length !== result.columns.length) {
    setColumnWidths(result.columns.map(() => DEFAULT_COL_WIDTH));
  }

  function formatCellValue(cell: unknown): string {
    if (cell === null || cell === undefined) return "";
    return String(cell);
  }

  return (
    <>
      <TooltipProvider delayDuration={300}>
      <Table style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
        <TableHeader>
          <TableRow>
            {result.columns.map((col, i) => (
              <TableHead
                key={i}
                className="text-xs font-semibold whitespace-nowrap relative select-none"
                style={{ width: columnWidths[i] }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block truncate pr-2">{col}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="font-mono text-xs">
                      {col}: <span className="text-muted-foreground">{result.column_types?.[i] ?? "unknown"}</span>
                    </p>
                  </TooltipContent>
                </Tooltip>
                {/* Resize handle */}
                <div
                  className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
                  onMouseDown={(e) => handleMouseDown(e, i)}
                />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((row, ri) => (
            <TableRow key={ri}>
              {row.map((cell, ci) => (
                <TableCell
                  key={ci}
                  className="text-xs py-1 whitespace-nowrap truncate cursor-pointer hover:bg-accent/40"
                  style={{ width: columnWidths[ci], maxWidth: columnWidths[ci] }}
                  onClick={() =>
                    setInspectedCell({
                      column: result.columns[ci],
                      value: cell === null ? "NULL" : formatCellValue(cell),
                    })
                  }
                  title="Click to inspect"
                >
                  {cell === null ? (
                    <span className="text-muted-foreground italic">NULL</span>
                  ) : (
                    formatCellValue(cell)
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </TooltipProvider>

      {/* Cell detail dialog */}
      <Dialog
        open={!!inspectedCell}
        onOpenChange={(v) => !v && setInspectedCell(null)}
      >
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono truncate">
              {inspectedCell?.column}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            <pre className="text-sm whitespace-pre-wrap break-words font-mono bg-muted/50 p-3 rounded">
              {inspectedCell?.value}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
