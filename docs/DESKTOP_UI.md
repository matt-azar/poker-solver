# Desktop Study workstation

Architecture decision and capability map for the React study client (`desktop/`) that talks to the existing `explorer` HTTP API. Numerical kernels are unchanged.

## Architecture decision (2026-10-31)

| Choice | Decision |
| --- | --- |
| Web client | React 19 + TypeScript + Vite |
| State | Zustand for study/layout/theme; query identity in the engine client |
| Engine transport | Typed `EngineClient` over the existing localhost HTTP API |
| Desktop shell | Tauri 2 planned for a later slice; browser + Vite proxy first |
| Static serving | Prefer `desktop/dist` when present; fall back to legacy `ui/` |
| Legacy UI | Kept under `ui/` for regression and fallback |

Rationale: the repository already exposes a proven explorer process boundary. Replacing the page with a typed client preserves solve/browse/save contracts without inventing a parallel API. Tauri packaging can wrap the same client and sidecar once the Study workspace is solid.

## Development

```sh
# terminal 1 — engine (from repo root, after cmake build)
explorer --port 8765

# terminal 2 — Study client
cd desktop && npm install && npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:8765`. Production:

```sh
cd desktop && npm run build
explorer   # serves desktop/dist when present
```

## Capability map

| Backend operation | Endpoint | Legacy UI (`ui/`) | New Study UI destination | Limitations | Tests |
| --- | --- | --- | --- | --- | --- |
| Status | `GET /api/status` | Poll 250ms | Status bar + solve strip + Graphs (`gap_series`) | Metrics null when unset; `samples` is chunk count, chart uses `gap_series` | `status.test.ts`; `test_explorer_http.cpp`, `test_session.cpp` |
| Solve | `POST /api/solve` | Setup form | Build workspace + Solve | 409 if running; empty≠absent bets | HTTP + session |
| Pause / Stop | `POST /api/pause`, `/stop` | Buttons | Solve controls | Chunk boundary before publish | session; HTTP stop |
| Continue | `POST …/continue` | Continue | Solve controls | Same solution id | HTTP |
| Browse node | `GET …/nodes/{id}` | Tree + matrix | Action history + matrix + navigator | One node at a time; root from `root_node_id` | browse + HTTP |
| Action EV | `GET …/values` | Calculate EVs | Inspector / Analysis | Decision only; may 202 | value worker |
| Runouts | `GET …/runouts` | Compare runouts | Lower dock + suit filter; row navigates | Chance / street only | engine; sparse HTTP |
| Next-card picker | chance `children` | Card grid | Board buttons → rank×suit picker | Legal cards from node only; board blockers marked | `cards.test.ts` |
| Equity | `GET …/equity` | Averages + hist | Equity tab: averages, clickable band filter, shape composition, top hands | Check-down (not chip EV); buckets + `oop_hands`/`ip_hands` | equity tests; `analysis.test.ts` |
| Categories | `GET …/categories` | Table | Categories tab with OOP/IP seat toggle; draws on flop/turn | River made-hand; flop/turn multi-label draws | hand categories; `analysis.test.ts` |
| Locks | PUT/DELETE `…/locks` | Hand detail | Lock drawer + inspector | All-zero PUT rejected; 0%≠unlock | HTTP + `locks.test.ts` |
| Resolve locked | `POST …/resolve-locked` | Resolve + warm-start | Solver menu + drawer | New solution + baseline | HTTP |
| Compare | `GET /api/compare` | Note | Compare workspace | Decision node | HTTP |
| Save / Open | `POST …/save`, `/open` | File fields | File menu / Build | PSOL v2 + locks; browser path fields | checkpoint HTTP |
| Recent | `GET /api/recent-solutions` | Dropdown | Library + File menu | Cap 10 | recent_files |
| Templates / ranges | `GET /api/templates`, `/ranges` | Dropdowns | Build + Library (ranges grouped by folder) | Nested `configs/ranges` folders; template dirs still flat | templates/range lib |
| Config parse | `POST /api/config` | Load config | Build | street/river text only | indirect |

## Numerical labels (do not relabel without math)

- Chip EV: root-centered, units `chips`
- Accuracy / Nash gap: NashConv (sum of BR gains); accuracy is NashConv/pot
- Equity: check-down, fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP); Study filters bands client-side using `oop_hands`/`ip_hands`
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list; `exclusive` false for draw tags
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is DELETE. All-zero PUT rows are rejected by the engine.

## Slice status

1. **Audit + contracts** — this document + `EngineClient`
2. **Study workspace** — tokens, adaptive layout, context/history, segmented strategy matrix, combo inspector, node navigation, solve controls against live API; optional dual-range layout; interactive board + chance card picker
3. **Analysis dock + Build + Library** — Range Explorer, Graphs (`gap_series`), Runouts, Equity (hist + band filter + composition), Categories (made-hand / draws), organized Build, Library lists with nested range folders
4. **Locks + Compare** — Lock drawer + Compare workspace wired to PUT/DELETE/resolve-locked/compare
5. **Desktop packaging** — Tauri 2 shell + `holdem-explorer` sidecar + Windows NSIS installer via CI artifact (unsigned). Browser + Vite/`explorer` path remains supported. See [Desktop packaging](#desktop-packaging).
6. **Visual/a11y/perf** — focus-visible + reduced-motion; compact collapse ≤1280; themes light/dark. Scaling/perf evidence captured as screenshots.

## Desktop packaging

| Item | Status |
| --- | --- |
| Browser Study client + localhost `explorer` | Supported |
| Vite `/api` proxy in `npm run dev` | Supported |
| `explorer` serving `desktop/dist` | Supported |
| Tauri 2 managed sidecar (`desktop/src-tauri`) | Supported — shell spawns `binaries/holdem-explorer` on port 8765; webview loads Vite `dist` |
| Windows NSIS installer | Supported via CI — workflow `Windows Installer` uploads `holdem-study-windows-installer` (`Holdem Study_0.1.0_x64-setup.exe`) |
| Native Open/Save dialogs | Browser prompts; Tauri adapter uses `@tauri-apps/plugin-dialog` when present (prompt fallback) |
| Code-signed official release | Not yet — CI artifact is unsigned |

### Windows installer (end users)

1. Open the packaging PR / Actions → **Windows Installer** (or download the artifact from a green run).
2. Download artifact `holdem-study-windows-installer`.
3. Run `Holdem Study_0.1.0_x64-setup.exe` (current-user install; WebView2 may bootstrap if missing).
4. Launch **Holdem Study** from the Start menu — no CMake/`npm` required.

Installer product name is `Holdem Study` (no apostrophe) because NSIS shortcut macros reject `Hold'em`. The window title remains `Hold'em Study`.

### Local packaging (maintainers)

```sh
# build explorer (MSVC), copy sidecar with target triple, then:
cd desktop
npm ci && npm run build
# place holdem-explorer-x86_64-pc-windows-msvc.exe under src-tauri/binaries/
npm run tauri:build
```

| Lock / compare op | UI | Backend |
| --- | --- | --- |
| Apply selected/full lock | Lock drawer / inspector | `PUT …/locks` |
| Unlock | Lock drawer / inspector | `DELETE …/locks` |
| Resolve locked | Solve/Tree menus + drawer | `POST …/resolve-locked` |
| Compare revisions | Compare workspace | `GET /api/compare` |

## Validation notes

- Unit: `cd desktop && npm test` (browse, locks, status/`gap_series`, cards, analysis helpers, action colors)
- Build: `cd desktop && npm run build`
- Live: solve against `explorer`; Graphs read `status.gap_series`; Status bar shows EV / NashConv / mem
- Visual targets: 1440×900 dark/light, 1920×1080 dual-range, 1280×800 compact
