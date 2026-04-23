import { useRef, useEffect, useCallback } from "react";
import { EditorView, keymap, placeholder as phPlugin } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
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
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  placeholder?: string;
  className?: string;
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  placeholder = "SELECT * FROM your_table LIMIT 100",
  className,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

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
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
      sql({ dialect: PostgreSQL }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      phPlugin(placeholder),
      updateListener,
      EditorView.lineWrapping,
      EditorView.theme({
        "&": {
          fontSize: "13px",
          minHeight: "100px",
          maxHeight: "300px",
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

  return <div ref={containerRef} className={className} />;
}
