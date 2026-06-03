import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Plot from "@observablehq/plot";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePersistedNumber } from "@/hooks/usePersistedNumber";
import type { QueryResult } from "@/lib/api";
import { isNumericColumnType } from "@/lib/utils";

interface Props {
  result: QueryResult;
}

type ChartType = "line" | "bar" | "scatter";
type ChartMode = "guided" | "custom";
type PlotDatum = Record<string, unknown>;
type PlotAxisType =
  | "linear"
  | "pow"
  | "sqrt"
  | "log"
  | "symlog"
  | "time"
  | "utc"
  | "point"
  | "band";
type PlotAxisScaleSelection = "auto" | PlotAxisType;
type PlotAxisRole = "x" | "y";
type PlotAxisOptions = {
  type: PlotAxisType;
};

const NONE_VALUE = "__none__";
const DEFAULT_HEIGHT = 420;
const AXIS_INFERENCE_SAMPLE_SIZE = 100;
const CUSTOM_PLOT_EDITOR_HEIGHT_STORAGE_KEY = "data-explorer.customPlotEditorHeight";
const CUSTOM_PLOT_EDITOR_HEIGHT_BOUNDS = { min: 120, max: 600 };
const DEFAULT_CUSTOM_PLOT_EDITOR_HEIGHT = 180;
const CUSTOM_PLOT_TOP_LEVEL_COMPLETIONS: Completion[] = [
  { label: "Plot", type: "namespace", detail: "@observablehq/plot" },
  { label: "data", type: "variable", detail: "PlotDatum[]" },
  { label: "columns", type: "variable", detail: "string[]" },
  { label: "columnTypes", type: "variable", detail: "string[]" },
  { label: "width", type: "variable", detail: "number" },
  { label: "height", type: "variable", detail: "number" },
];
const CUSTOM_PLOT_NAMESPACE_COMPLETIONS: Completion[] = Object.keys(Plot)
  .sort()
  .map((key) => ({
    label: key,
    type: typeof Plot[key as keyof typeof Plot] === "function" ? "function" : "property",
    detail: "Plot",
  }));
const AXIS_SCALE_OPTIONS: { value: PlotAxisScaleSelection; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "linear", label: "Linear" },
  { value: "pow", label: "Power" },
  { value: "sqrt", label: "Square root" },
  { value: "log", label: "Log" },
  { value: "symlog", label: "SymLog" },
  { value: "time", label: "Time" },
  { value: "utc", label: "UTC time" },
  { value: "point", label: "Point" },
  { value: "band", label: "Band" },
];
const PLOT_SCALE_TYPE_COMPLETIONS: Completion[] = AXIS_SCALE_OPTIONS.filter(
  (option): option is { value: PlotAxisType; label: string } => option.value !== "auto"
).map((option) => ({
  label: option.value,
  type: "constant",
  detail: `${option.label} scale`,
}));

export function QueryResultsChart({ result }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<Node | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [mode, setMode] = useState<ChartMode>("guided");
  const [chartType, setChartType] = useState<ChartType>("line");
  const defaults = useMemo(() => getDefaultColumns(result), [result]);
  const resultSignature = useMemo(
    () => `${result.columns.join("\u001f")}\u001e${result.column_types.join("\u001f")}`,
    [result.columns, result.column_types]
  );
  const [xColumn, setXColumn] = useState(defaults.xColumn);
  const [yColumn, setYColumn] = useState(defaults.yColumn);
  const [xAxisScale, setXAxisScale] = useState<PlotAxisScaleSelection>("auto");
  const [yAxisScale, setYAxisScale] = useState<PlotAxisScaleSelection>("auto");
  const [colorColumn, setColorColumn] = useState<string | null>(null);
  const [facetColumn, setFacetColumn] = useState<string | null>(null);
  const [customCode, setCustomCode] = useState(() =>
    createDefaultCustomCode(defaults.xColumn, defaults.yColumn, result)
  );
  const [appliedCustomCode, setAppliedCustomCode] = useState(customCode);
  const [renderError, setRenderError] = useState<string | null>(null);

  const data = useMemo(() => rowsToObjects(result), [result]);
  const width = Math.max(360, containerWidth - 32);

  useEffect(() => {
    setXColumn(defaults.xColumn);
    setYColumn(defaults.yColumn);
    setXAxisScale("auto");
    setYAxisScale("auto");
    setColorColumn(null);
    setFacetColumn(null);
    const nextCustomCode = createDefaultCustomCode(defaults.xColumn, defaults.yColumn, result);
    setCustomCode(nextCustomCode);
    setAppliedCustomCode(nextCustomCode);
  }, [defaults, result, resultSignature]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    resizeObserver.observe(container);
    setContainerWidth(container.clientWidth);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    removeRenderedPlot(plotRef.current);
    plotRef.current = null;
    setRenderError(null);

    if (result.columns.length === 0 || result.rows.length === 0) {
      container.replaceChildren();
      return;
    }

    try {
      const plot =
        mode === "custom"
          ? renderCustomPlot(appliedCustomCode, data, result.columns, result.column_types, width)
          : renderGuidedPlot({
              chartType,
              data,
              width,
              xColumn,
              yColumn,
              colorColumn,
              facetColumn,
              xAxisScale,
              yAxisScale,
              result,
            });

      container.replaceChildren(plot);
      plotRef.current = plot;
    } catch (e) {
      container.replaceChildren();
      setRenderError(e instanceof Error ? e.message : String(e));
    }

    return () => {
      removeRenderedPlot(plotRef.current);
      plotRef.current = null;
    };
  }, [
    appliedCustomCode,
    chartType,
    colorColumn,
    data,
    facetColumn,
    mode,
    result.column_types,
    result.columns,
    result.rows.length,
    width,
    xAxisScale,
    xColumn,
    yAxisScale,
    yColumn,
  ]);

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No columns are available to chart.
      </div>
    );
  }

  if (result.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No rows are available to chart.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === "guided" ? "default" : "outline"}
            onClick={() => setMode("guided")}
          >
            Guided
          </Button>
          <Button
            size="sm"
            variant={mode === "custom" ? "default" : "outline"}
            onClick={() => setMode("custom")}
          >
            Custom Plot code
          </Button>
        </div>

        {mode === "guided" ? (
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-8">
            <SelectField
              label="Chart"
              value={chartType}
              onValueChange={(value) => setChartType(value as ChartType)}
              options={[
                { value: "line", label: "Line" },
                { value: "bar", label: "Bar" },
                { value: "scatter", label: "Scatter" },
              ]}
            />
            <SelectField
              label="X"
              value={xColumn}
              onValueChange={setXColumn}
              options={result.columns.map((column) => ({ value: column, label: column }))}
            />
            <SelectField
              label="Y"
              value={yColumn}
              onValueChange={setYColumn}
              options={result.columns.map((column) => ({ value: column, label: column }))}
            />
            <SelectField
              label="X scale"
              value={xAxisScale}
              onValueChange={(value) => setXAxisScale(value as PlotAxisScaleSelection)}
              options={axisScaleOptionsWithInferred(
                inferPlotAxisOptions(result, xColumn, "x", chartType)
              )}
            />
            <SelectField
              label="Y scale"
              value={yAxisScale}
              onValueChange={(value) => setYAxisScale(value as PlotAxisScaleSelection)}
              options={axisScaleOptionsWithInferred(
                inferPlotAxisOptions(result, yColumn, "y", chartType)
              )}
            />
            <SelectField
              label="Color"
              value={colorColumn ?? NONE_VALUE}
              onValueChange={(value) =>
                setColorColumn(value === NONE_VALUE ? null : value)
              }
              options={[
                { value: NONE_VALUE, label: "None" },
                ...result.columns.map((column) => ({ value: column, label: column })),
              ]}
            />
            <SelectField
              label="Facet"
              value={facetColumn ?? NONE_VALUE}
              onValueChange={(value) =>
                setFacetColumn(value === NONE_VALUE ? null : value)
              }
              options={[
                { value: NONE_VALUE, label: "None" },
                ...result.columns.map((column) => ({ value: column, label: column })),
              ]}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Plot.plot code</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAppliedCustomCode(customCode)}
              >
                Render code
              </Button>
            </div>
            <CustomPlotCodeEditor
              value={customCode}
              onChange={setCustomCode}
              onRun={setAppliedCustomCode}
            />
            <p className="text-xs text-muted-foreground">
              Available variables: Plot, data, columns, columnTypes, width, height.
              Return the result of Plot.plot(...), or enter Plot.plot(...) as an expression.
            </p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {renderError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {renderError}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="min-h-[420px] w-full text-foreground [&_svg]:max-w-full"
        />
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function customPlotCompletionSource(context: CompletionContext) {
  const scaleTypeValue = context.matchBefore(/(?:^|[\s,{])type\s*:\s*["'][\w-]*$/);
  if (scaleTypeValue) {
    const quoteIndex = Math.max(
      scaleTypeValue.text.lastIndexOf('"'),
      scaleTypeValue.text.lastIndexOf("'")
    );
    return {
      from: scaleTypeValue.from + quoteIndex + 1,
      options: PLOT_SCALE_TYPE_COMPLETIONS,
      validFor: /^[\w-]*$/,
    };
  }

  const plotMember = context.matchBefore(/\bPlot\.[$\w]*$/);
  if (plotMember) {
    return {
      from: plotMember.from + "Plot.".length,
      options: CUSTOM_PLOT_NAMESPACE_COMPLETIONS,
      validFor: /^[$\w]*$/,
    };
  }

  const word = context.matchBefore(/\b[$\w]*$/);
  if (!word || (!context.explicit && word.from === word.to)) return null;

  return {
    from: word.from,
    options: CUSTOM_PLOT_TOP_LEVEL_COMPLETIONS,
    validFor: /^[$\w]*$/,
  };
}

function CustomPlotCodeEditor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  const javascriptSupport = useMemo(() => javascript(), []);
  const [height, setHeight] = usePersistedNumber(
    CUSTOM_PLOT_EDITOR_HEIGHT_STORAGE_KEY,
    DEFAULT_CUSTOM_PLOT_EDITOR_HEIGHT,
    CUSTOM_PLOT_EDITOR_HEIGHT_BOUNDS
  );
  const resizing = useRef(false);

  const createView = useCallback(() => {
    if (!containerRef.current) return;

    const isDark = document.documentElement.classList.contains("dark");
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });
    const runKeymap = keymap.of([
      {
        key: "Mod-Enter",
        run: (view) => {
          onRunRef.current(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const extensions = [
      runKeymap,
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...closeBracketsKeymap,
        indentWithTab,
      ]),
      languageCompartmentRef.current.of(javascriptSupport),
      autocompletion({
        activateOnTyping: true,
        override: [customPlotCompletionSource],
      }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      updateListener,
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Plot.plot code",
        spellcheck: "false",
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "12px",
          border: "1px solid hsl(var(--border))",
          borderRadius: "var(--radius)",
        },
        "&.cm-focused": {
          outline: "2px solid hsl(var(--ring))",
          outlineOffset: "-1px",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
        },
        ".cm-content": {
          padding: "8px 0",
        },
        ".cm-gutters": {
          backgroundColor: "hsl(var(--muted) / 0.35)",
          borderRight: "1px solid hsl(var(--border))",
          color: "hsl(var(--muted-foreground))",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minWidth: "2.5rem",
          padding: "0 8px",
        },
        ".cm-line": {
          padding: "0 12px",
        },
      }),
    ];

    if (isDark) {
      extensions.push(oneDark);
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });
  }, [javascriptSupport]);

  useEffect(() => {
    createView();
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [createView]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(javascriptSupport),
    });
  }, [javascriptSupport]);

  const handleResizeDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = true;
    const startY = event.clientY;
    const startHeight = height;

    const onMove = (moveEvent: MouseEvent) => {
      if (!resizing.current) return;
      setHeight(startHeight + moveEvent.clientY - startY);
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [height, setHeight]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div>
      <div style={{ height }} className="overflow-hidden">
        <div ref={containerRef} className="h-full" />
      </div>
      <div
        className="h-1.5 cursor-row-resize rounded-b bg-border/50 transition-colors hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={handleResizeDown}
      />
    </div>
  );
}

function renderGuidedPlot({
  chartType,
  data,
  width,
  xColumn,
  yColumn,
  colorColumn,
  facetColumn,
  xAxisScale,
  yAxisScale,
  result,
}: {
  chartType: ChartType;
  data: PlotDatum[];
  width: number;
  xColumn: string;
  yColumn: string;
  colorColumn: string | null;
  facetColumn: string | null;
  xAxisScale: PlotAxisScaleSelection;
  yAxisScale: PlotAxisScaleSelection;
  result: QueryResult;
}) {
  const xAxis = resolvePlotAxisOptions(xAxisScale, result, xColumn, "x", chartType);
  const yAxis = resolvePlotAxisOptions(yAxisScale, result, yColumn, "y", chartType);
  const channels = {
    x: xColumn,
    y: yColumn,
    ...(colorColumn ? { stroke: colorColumn, fill: colorColumn, z: colorColumn } : {}),
    ...(facetColumn ? { fx: facetColumn } : {}),
    tip: true,
  };
  const marks: Plot.Markish[] =
    chartType === "bar"
      ? [Plot.barY(data, channels)]
      : chartType === "scatter"
      ? [Plot.dot(data, channels)]
      : [Plot.line(data, channels), Plot.dot(data, channels)];

  return Plot.plot({
    width,
    height: DEFAULT_HEIGHT,
    grid: true,
    x: xAxis,
    y: yAxis,
    color: colorColumn ? { legend: true } : undefined,
    marginLeft: 56,
    marginBottom: 48,
    marks,
    style: {
      background: "transparent",
      color: "currentColor",
      fontSize: "12px",
    },
  });
}

function renderCustomPlot(
  source: string,
  data: PlotDatum[],
  columns: string[],
  columnTypes: string[],
  width: number
) {
  const factory = createCustomPlotFactory(source);
  const result = factory(Plot, data, columns, columnTypes, width, DEFAULT_HEIGHT);

  if (!(result instanceof Node)) {
    throw new Error("Custom code must return the result of Plot.plot(...).");
  }

  return result;
}

function createCustomPlotFactory(source: string) {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error("Enter Plot.plot(...) code to render a custom chart.");
  }

  const expressionSource = trimmedSource.replace(/;\s*$/, "");
  try {
    return new Function(
      "Plot",
      "data",
      "columns",
      "columnTypes",
      "width",
      "height",
      `return (${expressionSource});`
    ) as CustomPlotFactory;
  } catch {
    return new Function(
      "Plot",
      "data",
      "columns",
      "columnTypes",
      "width",
      "height",
      trimmedSource
    ) as CustomPlotFactory;
  }
}

type CustomPlotFactory = (
  PlotNamespace: typeof Plot,
  data: PlotDatum[],
  columns: string[],
  columnTypes: string[],
  width: number,
  height: number
) => unknown;

function removeRenderedPlot(plot: Node | null) {
  if (plot?.parentNode) {
    plot.parentNode.removeChild(plot);
  }
}

function getDefaultColumns(result: QueryResult) {
  const numericColumn = result.columns.find((_, index) =>
    isNumericColumnType(result.column_types[index])
  );
  const xColumn =
    result.columns.find((column) => column !== numericColumn) ?? result.columns[0] ?? "";
  const yColumn = numericColumn ?? result.columns[1] ?? result.columns[0] ?? "";

  return { xColumn, yColumn };
}

function createDefaultCustomCode(
  xColumn: string,
  yColumn: string,
  result: QueryResult
) {
  const xAxis = inferPlotAxisOptions(result, xColumn, "x", "scatter");
  const yAxis = inferPlotAxisOptions(result, yColumn, "y", "scatter");

  return `Plot.plot({
  width,
  height,
  grid: true,
  x: ${formatPlotAxisOptions(xAxis)},
  y: ${formatPlotAxisOptions(yAxis)},
  marginLeft: 56,
  marginBottom: 48,
  marks: [
    Plot.dot(data, { x: ${JSON.stringify(xColumn)}, y: ${JSON.stringify(yColumn)}, tip: true })
  ],
  style: {
    background: "transparent",
    color: "currentColor",
    fontSize: "12px"
  }
})`;
}

function rowsToObjects(result: QueryResult): PlotDatum[] {
  return result.rows.map((row) => {
    const datum: PlotDatum = {};
    result.columns.forEach((column, index) => {
      datum[column] = normalizePlotValue(row[index], result.column_types[index]);
    });
    return datum;
  });
}

function normalizePlotValue(value: unknown, columnType: string | undefined) {
  if (value === null || value === undefined) return null;

  if (isTemporalColumnType(columnType)) {
    const date = new Date(String(value));
    if (!Number.isNaN(date.getTime())) return date;
  }

  if (isNumericColumnType(columnType)) {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }

  return value;
}

function inferPlotAxisOptions(
  result: QueryResult,
  column: string,
  role: PlotAxisRole,
  chartType: ChartType
): PlotAxisOptions {
  const columnIndex = result.columns.indexOf(column);
  const columnType = columnIndex >= 0 ? result.column_types[columnIndex] : undefined;
  const values =
    columnIndex >= 0
      ? result.rows.slice(0, AXIS_INFERENCE_SAMPLE_SIZE).map((row) => row[columnIndex])
      : [];

  if (isTemporalColumnType(columnType) || valuesLookTemporal(values)) {
    return { type: "time" };
  }

  if (isNumericColumnType(columnType) || valuesLookNumeric(values)) {
    return { type: "linear" };
  }

  return { type: role === "x" && chartType === "bar" ? "band" : "point" };
}

function resolvePlotAxisOptions(
  selection: PlotAxisScaleSelection,
  result: QueryResult,
  column: string,
  role: PlotAxisRole,
  chartType: ChartType
): PlotAxisOptions {
  if (selection !== "auto") {
    return { type: selection };
  }

  return inferPlotAxisOptions(result, column, role, chartType);
}

function axisScaleOptionsWithInferred(inferred: PlotAxisOptions) {
  return AXIS_SCALE_OPTIONS.map((option) =>
    option.value === "auto"
      ? { ...option, label: `Auto (${formatAxisScaleLabel(inferred.type)})` }
      : option
  );
}

function formatAxisScaleLabel(type: PlotAxisType) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatPlotAxisOptions(options: PlotAxisOptions) {
  return `{ type: ${JSON.stringify(options.type)} }`;
}

function isTemporalColumnType(columnType: string | undefined) {
  if (!columnType) return false;

  return /\b(?:date|time|timestamp)\b/i.test(columnType);
}

function valuesLookTemporal(values: unknown[]) {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);
  if (nonNullValues.length === 0) return false;

  const temporalValues = nonNullValues.filter((value) => {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value !== "string") return false;
    if (!/\d{4}-\d{1,2}-\d{1,2}|T\d{1,2}:\d{2}|:\d{2}/.test(value)) return false;
    return !Number.isNaN(new Date(value).getTime());
  });

  return temporalValues.length / nonNullValues.length >= 0.8;
}

function valuesLookNumeric(values: unknown[]) {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);
  if (nonNullValues.length === 0) return false;

  const numericValues = nonNullValues.filter((value) => {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string" || value.trim() === "") return false;
    return Number.isFinite(Number(value));
  });

  return numericValues.length / nonNullValues.length >= 0.8;
}
