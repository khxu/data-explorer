import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
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
import { cn, formatQueryCellValue, isNumericColumnType } from "@/lib/utils";

interface Props {
  result: QueryResult;
  renderTimestampsAsIso?: boolean;
}

const DEFAULT_COL_WIDTH = 150;
const MIN_COL_WIDTH = 60;
const HEADER_HEIGHT = 40;
const ROW_HEIGHT = 29;
const ROW_OVERSCAN = 8;

export function ResizableResultsTable({ result, renderTimestampsAsIso = false }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [columnWidths, setColumnWidths] = useState<number[]>(() =>
    result.columns.map(() => DEFAULT_COL_WIDTH)
  );
  const [inspectedCell, setInspectedCell] = useState<{
    column: string;
    value: string;
  } | null>(null);
  const [copiedCell, setCopiedCell] = useState(false);

  const resizing = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const updateViewportHeight = () => {
      setViewportHeight(scrollEl.clientHeight);
    };

    updateViewportHeight();

    const resizeObserver = new ResizeObserver(updateViewportHeight);
    resizeObserver.observe(scrollEl);

    return () => resizeObserver.disconnect();
  }, []);

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

  useEffect(() => {
    setColumnWidths(result.columns.map(() => DEFAULT_COL_WIDTH));
  }, [result.columns]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (scrollEl) {
      scrollEl.scrollTop = 0;
    }
    setScrollTop(0);
  }, [result.rows]);

  const virtualRows = useMemo(() => {
    const rowCount = result.rows.length;
    const visibleStart = Math.max(0, scrollTop - HEADER_HEIGHT);
    const estimatedStartIndex = Math.max(
      0,
      Math.floor(visibleStart / ROW_HEIGHT) - ROW_OVERSCAN
    );
    const startIndex = Math.min(estimatedStartIndex, rowCount);
    const endIndex = Math.min(
      rowCount,
      Math.ceil((visibleStart + viewportHeight) / ROW_HEIGHT) + ROW_OVERSCAN
    );

    return {
      startIndex,
      rows: result.rows.slice(startIndex, endIndex),
      topSpacerHeight: startIndex * ROW_HEIGHT,
      bottomSpacerHeight: Math.max(0, (rowCount - endIndex) * ROW_HEIGHT),
    };
  }, [result.rows, scrollTop, viewportHeight]);

  const numericColumns = useMemo(
    () => result.columns.map((_, index) => isNumericColumnType(result.column_types?.[index])),
    [result.columns, result.column_types]
  );

  function formatCellValue(cell: unknown, columnIndex: number): string {
    return formatQueryCellValue(cell, result.column_types?.[columnIndex], {
      renderTimestampsAsIso,
    });
  }

  async function handleCopyCellValue() {
    if (!inspectedCell) return;

    try {
      await navigator.clipboard.writeText(inspectedCell.value);
      setCopiedCell(true);
      window.setTimeout(() => setCopiedCell(false), 2000);
    } catch (e) {
      console.error("Failed to copy cell value:", e);
    }
  }

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <div
          ref={scrollRef}
          className="h-full w-full overflow-auto"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <Table style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-background">
                {result.columns.map((col, i) => {
                  const isNumericColumn = numericColumns[i];

                  return (
                    <TableHead
                      key={i}
                      className="text-xs font-semibold whitespace-nowrap relative select-none"
                      style={{ width: columnWidths[i] }}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              "block truncate pr-2",
                              isNumericColumn && "text-right tabular-nums"
                            )}
                          >
                            {col}
                          </span>
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
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {virtualRows.topSpacerHeight > 0 && (
                <TableRow aria-hidden="true" className="border-0 hover:bg-transparent">
                  <TableCell
                    colSpan={result.columns.length}
                    className="border-0 p-0"
                    style={{ height: virtualRows.topSpacerHeight }}
                  />
                </TableRow>
              )}
              {virtualRows.rows.map((row, offset) => {
                const ri = virtualRows.startIndex + offset;

                return (
                  <TableRow key={ri} style={{ height: ROW_HEIGHT }}>
                    {row.map((cell, ci) => {
                      const isNumericColumn = numericColumns[ci];

                      return (
                        <TableCell
                          key={ci}
                          className={cn(
                            "text-xs py-1 whitespace-nowrap truncate cursor-pointer hover:bg-accent/40",
                            isNumericColumn && "text-right tabular-nums"
                          )}
                          style={{ width: columnWidths[ci], maxWidth: columnWidths[ci] }}
                          onClick={() =>
                            setInspectedCell({
                              column: result.columns[ci],
                              value: cell === null ? "NULL" : formatCellValue(cell, ci),
                            })
                          }
                          title="Click to inspect"
                        >
                          {cell === null ? (
                            <span className="text-muted-foreground italic">NULL</span>
                          ) : (
                            formatCellValue(cell, ci)
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
              {virtualRows.bottomSpacerHeight > 0 && (
                <TableRow aria-hidden="true" className="border-0 hover:bg-transparent">
                  <TableCell
                    colSpan={result.columns.length}
                    className="border-0 p-0"
                    style={{ height: virtualRows.bottomSpacerHeight }}
                  />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </TooltipProvider>

      {/* Cell detail dialog */}
      <Dialog
        open={!!inspectedCell}
        onOpenChange={(v) => {
          if (!v) {
            setInspectedCell(null);
            setCopiedCell(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader className="flex-row items-center justify-between gap-3 pr-8">
            <DialogTitle className="text-sm font-mono truncate">
              {inspectedCell?.column}
            </DialogTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyCellValue}
              disabled={!inspectedCell}
              title="Copy cell value to clipboard"
            >
              {copiedCell ? "✓ Copied" : "Copy"}
            </Button>
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
