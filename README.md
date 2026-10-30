# CanvasToNotion v2

Syncs Canvas LMS assignments into Notion with full telemetry: every observed
change is snapshotted locally (SQLite), and Notion is kept as a rich, readable
projection — real page bodies, protected notes sections, and per-assignment
activity logs.

## Architecture

```
Canvas ──→ SQLite (canonical mirror + snapshots) ──→ Notion (projection)
                │
                └── debug MCP server (sync_status, get_assignment,
                    verify_assignment, force_sync, list_courses)
```

- **Language**: TypeScript (Node ≥22). Official `@notionhq/client` v5.
- **Canvas auth** (swappable backends, in priority order):
  1. `CANVAS_TOKEN` — personal access token (Account → Settings → + New Access Token)
  2. Mobile-QR OAuth — `npm run auth:qr "<decoded QR URL>"` (for schools that disable tokens); refreshes itself forever
- **Storage**: `data/cantn.sqlite` — courses, assignments, submission state, and
  an append-only `snapshots` table capturing every observed change.
- **Notion layout**: `🎓 Canvas HQ` page → `Assignments` + `Courses` databases,
  related. Created by `npm run setup`. Each assignment page body starts with a
  facts list (due dates, points, status, submission info, Canvas link) followed
  by the full rendered description — enough for agents (Notion MCP) to work
  with assignments without touching Canvas directly.
- **Calendar titles**: assignment titles are prefixed with the class name (for
  example, `[Biology 101] Syllabus Quiz`) so events remain identifiable in
  Notion Calendar.

## Ownership model

| Thing | Owner |
|---|---|
| Mirrored properties (title, dates, status, score, …) | Sync |
| `In Progress`, `Hidden`, `Do Not Sync` checkboxes | You (sync preserves them) |
| Page body `📋 Assignment Details` section | Sync (re-rendered on change) |
| Page body `🗒️ Notes` section | You & agents — sync never touches |
| Page body `🕘 Activity` entries | Sync appends-only |

`Do Not Sync` ✅ freezes a page completely (use instead of the old "Dont show" status).

## Retry behavior

Assignment observations, snapshots, and pending Notion projections commit in one
SQLite transaction. A failed projection stays pending until its properties, details,
and activity writes all finish successfully. Incremental runs retry pending work
for currently observed courses even when Canvas returns no updated assignments.
`Do Not Sync` pages remain pending without writes and catch up after the flag is
cleared. Full syncs also queue unchanged assignments to refresh their details.

The store adds `pending_assignment_projections` on initialization. It cannot infer
which projections failed before this tracking existed; an explicitly requested
full sync is needed to reconcile those older gaps. Keep the SQLite database on
persistent storage and run only one sync writer.

Delivery is at least once: if Notion accepts a write but its response is lost,
a retry can repeat an activity entry. This change does not make the existing
page-body replacement transactional; it currently deletes and rebuilds Notes
blocks too, so interruption during replacement can lose user content. Resolve
that separately before unattended deployment.

## Setup

```bash
npm install
cp .env.example .env          # fill in CANVAS_DOMAIN, NOTION_TOKEN, NOTION_HQ_PAGE_ID
npm run auth:token -- <token> # verify your Canvas token, then add it to .env
npm run setup                 # creates Canvas HQ databases in Notion
npm run sync                  # first (full) sync
```

Fallback if token creation is ever disabled: `npm run auth:qr -- "<decoded QR URL>"`.

## Deploy (Mac homebase)

```bash
./deploy/bootstrap.sh
```

Installs deps, writes a launchd plist honoring `SYNC_INTERVAL_MINUTES` (default
10), and loads it. Logs land in `data/*.log`.

## Debug MCP

Add to an MCP client config:

```json
{ "command": "npx", "args": ["tsx", "src/mcp/server.ts"], "cwd": "/path/to/CanvasToNotion" }
```

Tools: `sync_status`, `get_assignment(id)`, `verify_assignment(id)` (live
Canvas-vs-store drift check), `force_sync(full?)`, `list_courses`.
