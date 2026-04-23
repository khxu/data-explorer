# Data Explorer

A local desktop app for querying data files with [DuckDB](https://duckdb.org/). Point it at Parquet, CSV, or JSON files on your machine, organize them with tags and projects, write SQL, and export results — all without uploading anything or spinning up a server.

Built with [Tauri v2](https://tauri.app/) + React + TypeScript on the frontend and Rust on the backend.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Tauri v2 system dependencies — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

### Install & Run

```bash
npm install
npm run tauri dev
```

The first build will take a few minutes while Rust compiles DuckDB and SQLite from source. Subsequent builds are fast.

### Build for Distribution

```bash
npm run tauri build
```

This produces a native app bundle in `src-tauri/target/release/bundle/`.

---

## User Flows

### 1. Register a Data Source

Before you can query anything, you need to tell Data Explorer where your files live.

1. In the **sidebar**, click the **+** button next to "Data Sources"
2. Click **Browse** to pick a file (`.parquet`, `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`)
3. Give it a **table name** — this is the name you'll use in SQL queries (e.g., `sales`, `users_2024`). It auto-fills from the filename.
4. Optionally assign **tags** to organize it (you can always add tags later)
5. Click **Register**

The file stays on disk — Data Explorer just creates a DuckDB view pointing at it.

### 2. Query Your Data

1. Click on the **Query** tab (or click any data source in the sidebar to auto-populate a `SELECT * FROM "table" LIMIT 100` query)
2. Write SQL in the editor — you can reference any registered table by its name
3. Press **⌘+Enter** (Mac) or **Ctrl+Enter** (Windows/Linux) to run, or click the **▶ Run** button
4. Results appear in a scrollable table below the editor, with row count and execution time

You have access to all of DuckDB's SQL capabilities — joins across tables, window functions, aggregations, CTEs, etc.

### 3. Organize with Tags

Tags let you categorize data sources across projects.

1. Click the **⚙** button next to "Tags" in the sidebar
2. Create tags with names and colors (e.g., "marketing", "raw-data", "2024")
3. When registering a data source, select which tags apply
4. Tags appear as colored badges in the sidebar

### 4. Create Projects

Projects are saved views that filter data sources by tags. A data source can appear in multiple projects.

1. Click the **+** button next to "Projects" in the sidebar
2. Name the project and optionally add a description
3. Select which **tags** define the project — any data source with a matching tag will appear when that project is active
4. Click **All Sources** to go back to the unfiltered view

For example, a project called "Q4 Analysis" might filter on tags "q4" and "revenue", showing only the data sources relevant to that work.

### 5. Export Results

After running a query, you can save the results to a new file.

1. Run a query
2. Click the **Export** button that appears below the editor
3. Choose a format — **Parquet** or **CSV**
4. Click **Browse** to pick a save location and filename
5. Click **Export**

**Safety guardrail:** Data Explorer will never overwrite an existing file or write to a path that matches a registered data source. Exports always create new files.

### 6. Browse Query History

Every query you run is logged with its SQL, status, timing, and a small result sample.

1. Click the **History** tab
2. Browse past queries — successful ones show row count and execution time, failed ones show the error message
3. Click **Reuse** on any entry to load its SQL back into the query editor and switch to the Query tab

---

## Architecture

```
┌─────────────────────────────────────┐
│  React Frontend (shadcn/ui)         │
│  ┌───────┐ ┌──────┐ ┌───────────┐  │
│  │Query  │ │Side- │ │ History   │  │
│  │Editor │ │bar   │ │ Panel     │  │
│  └───┬───┘ └──┬───┘ └─────┬─────┘  │
│      └────────┴────────────┘        │
│               │ invoke()            │
├───────────────┼─────────────────────┤
│  Rust Backend │                     │
│  ┌────────────┴──────────────┐      │
│  │  Tauri Command Layer      │      │
│  ├──────────┬────────────────┤      │
│  │ DuckDB   │  SQLite        │      │
│  │ (queries)│  (metadata,    │      │
│  │          │   history)     │      │
│  └──────────┴────────────────┘      │
└─────────────────────────────────────┘
```

- **DuckDB** runs in-memory in the Rust backend. Registered files are loaded as views (`read_parquet`, `read_csv`, `read_json_auto`) and re-registered before each query so changes to the underlying files are picked up automatically.
- **SQLite** stores all persistent metadata: registered data sources, tags, projects, and query history (with truncated result samples to keep the database small).
- **Tauri** bridges the frontend and backend via typed `invoke()` commands with native OS file dialogs for picking files and save locations.

## Supported File Formats

| Format | Extensions |
|--------|-----------|
| Parquet | `.parquet`, `.pq` |
| CSV | `.csv`, `.tsv` |
| JSON | `.json` |
| Newline-delimited JSON | `.jsonl`, `.ndjson` |

## Development

### Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### Project Structure

```
src/                          # React frontend
├── components/               # UI components (Sidebar, QueryEditor, HistoryPanel, dialogs)
├── components/ui/            # shadcn/ui primitives
├── hooks/useAppState.tsx     # Global app state context
└── lib/api.ts                # Typed wrappers for Tauri invoke() calls

src-tauri/src/                # Rust backend
├── lib.rs                    # Tauri app setup and state management
├── db.rs                     # SQLite connection and migrations
├── duckdb_engine.rs          # DuckDB connection and view registration
├── error.rs                  # Error types
└── commands/                 # Tauri command handlers
    ├── data_sources.rs       # Register/remove/list data files
    ├── tags.rs               # Tag CRUD and assignment
    ├── projects.rs           # Project CRUD (tag-based filters)
    ├── queries.rs            # Execute SQL, query history
    └── export.rs             # Export results with overwrite protection
```

### Key Commands

```bash
npm run tauri dev       # Run in development mode with hot reload
npm run tauri build     # Build for production
npm run build           # Build frontend only (TypeScript + Vite)
```
