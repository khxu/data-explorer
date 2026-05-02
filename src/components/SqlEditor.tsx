import { useRef, useEffect, useCallback, useMemo } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder as phPlugin,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { schemaCompletionSource, type SQLNamespace } from "@codemirror/lang-sql";
import { DuckDBDialect } from "@marimo-team/codemirror-sql/dialects";
import { oneDark } from "@codemirror/theme-one-dark";
import { usePersistedNumber } from "@/hooks/usePersistedNumber";
import type { DataSourceSchema } from "@/lib/api";
import {
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  LanguageSupport,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
} from "@codemirror/autocomplete";

interface SqlEditorProps {
  value: string;
  dataSourceSchemas?: DataSourceSchema[];
  onChange: (value: string) => void;
  onRun?: () => void;
  placeholder?: string;
  className?: string;
}

const SQL_EDITOR_HEIGHT_STORAGE_KEY = "data-explorer.sqlEditorHeight";
const SQL_EDITOR_HEIGHT_BOUNDS = { min: 80, max: 600 };
const DEFAULT_SQL_EDITOR_HEIGHT = 150;

export function SqlEditor({
  value,
  dataSourceSchemas = [],
  onChange,
  onRun,
  placeholder = "SELECT * FROM your_table LIMIT 100",
  className,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  const completionSchema = useMemo(
    () => buildCompletionSchema(dataSourceSchemas),
    [dataSourceSchemas]
  );
  const sqlSupport = useMemo(
    () =>
      new LanguageSupport(DuckDBDialect.language, [
        DuckDBDialect.language.data.of({
          autocomplete: schemaCompletionSource({
            dialect: DuckDBDialect,
            schema: completionSchema,
          }),
        }),
      ]),
    [completionSchema]
  );
  const sqlSupportRef = useRef(sqlSupport);
  sqlSupportRef.current = sqlSupport;

  const createView = useCallback(() => {
    if (!containerRef.current) return;

    const isDark = document.documentElement.classList.contains("dark");

    const runKeymap = keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          onRunRef.current?.();
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

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
      sqlCompartmentRef.current.of(sqlSupportRef.current),
      autocompletion({ activateOnTyping: true }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      phPlugin(placeholder),
      updateListener,
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.theme({
        "&": {
          fontSize: "13px",
          height: "100%",
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

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
  }, []); // intentionally empty — uses refs for callbacks

  // Create editor on mount
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
      effects: sqlCompartmentRef.current.reconfigure(sqlSupport),
    });
  }, [sqlSupport]);

  // Sync external value changes (e.g., clicking sidebar populates SQL)
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

  const [height, setHeight] = usePersistedNumber(
    SQL_EDITOR_HEIGHT_STORAGE_KEY,
    DEFAULT_SQL_EDITOR_HEIGHT,
    SQL_EDITOR_HEIGHT_BOUNDS
  );
  const resizing = useRef(false);

  const handleResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startY = e.clientY;
    const startH = height;

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      setHeight(
        Math.max(
          SQL_EDITOR_HEIGHT_BOUNDS.min,
          Math.min(startH + ev.clientY - startY, SQL_EDITOR_HEIGHT_BOUNDS.max)
        )
      );
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
  }, [height]);

  return (
    <div className={className}>
      <div style={{ height }} className="overflow-hidden">
        <div ref={containerRef} className="h-full" />
      </div>
      <div
        className="h-1.5 cursor-row-resize bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors rounded-b"
        onMouseDown={handleResizeDown}
      />
    </div>
  );
}

function buildCompletionSchema(dataSourceSchemas: DataSourceSchema[]): SQLNamespace {
  const schema: Record<string, Completion[]> = {};
  for (const dataSource of dataSourceSchemas) {
    schema[dataSource.name] = dataSource.columns.map((column) => ({
      label: column.name,
      type: "property",
      detail: column.data_type,
    }));
  }
  return schema;
}
