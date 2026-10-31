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
| Equity | `GET …/equity` | Averages only | Equity tab: averages + OOP/IP histograms | Check-down; work limit; buckets = input mass | equity tests; `analysis.test.ts` |
| Categories | `GET …/categories` | Table | Categories tab with OOP/IP seat toggle | Five-card made-hand; parallel `categories`+`fractions` arrays | hand categories; `analysis.test.ts` |
| Locks | PUT/DELETE `…/locks` | Hand detail | Lock drawer + inspector | All-zero PUT rejected; 0%≠unlock | HTTP + `locks.test.ts` |
| Resolve locked | `POST …/resolve-locked` | Resolve + warm-start | Solver menu + drawer | New solution + baseline | HTTP |
| Compare | `GET /api/compare` | Note | Compare workspace | Decision node | HTTP |
| Save / Open | `POST …/save`, `/open` | File fields | File menu / Build | PSOL v2 + locks; browser path fields | checkpoint HTTP |
| Recent | `GET /api/recent-solutions` | Dropdown | Library + File menu | Cap 10 | recent_files |
| Templates / ranges | `GET /api/templates`, `/ranges` | Dropdowns | Build + Library | Flat dirs | templates/range lib |
| Config parse | `POST /api/config` | Load config | Build | street/river text only | indirect |

## Numerical labels (do not relabel without math)

- Chip EV: root-centered, units `chips`
- Accuracy / Nash gap: NashConv (sum of BR gains); accuracy is NashConv/pot
- Equity: check-down, fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP)
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is DELETE. All-zero PUT rows are rejected by the engine.

## Slice status

1. **Audit + contracts** — this document + `EngineClient`
2. **Study workspace** — tokens, adaptive layout, context/history, segmented strategy matrix, combo inspector, node navigation, solve controls against live API; optional dual-range layout; interactive board + chance card picker
3. **Analysis dock + Build + Library** — Range Explorer, Graphs (`gap_series`), Runouts, Equity (OOP/IP hist), Categories (seat toggle), organized Build, Library lists
4. **Locks + Compare** — Lock drawer + Compare workspace wired to PUT/DELETE/resolve-locked/compare
5. **Desktop packaging** — Tauri 2 shell + `explorer` sidecar + Windows NSIS installer **in progress** on `cursor/windows-installer-181d`. Browser + Vite/`explorer` path remains supported. See [Desktop packaging](#desktop-packaging).
6. **Visual/a11y/perf** — focus-visible + reduced-motion; compact collapse ≤1280; themes light/dark. Scaling/perf evidence captured as screenshots; packaged offline smoke follows the installer CI artifact.

## Desktop packaging

| Item | Status |
| --- | --- |
| Browser Study client + localhost `explorer` | Supported |
| Vite `/api` proxy in `npm run dev` | Supported |
| `explorer` serving `desktop/dist` | Supported |
| Tauri 2 managed sidecar (`desktop/src-tauri`) | In progress — shell spawns `binaries/explorer` on port 8765; webview loads Vite `dist` |
| Windows NSIS installer | In progress — GitHub Actions workflow `windows-installer` uploads setup `.exe` artifact |
| Native Open/Save dialogs | Browser prompts today; Tauri adapter uses `@tauri-apps/plugin-dialog` when `__TAURI__` is present |
| Code-signed official release | Not yet — CI artifact is unsigned |

### Windows installer (once CI green)

1. Run workflow **Windows installer** (Actions → `windows-installer` → Run workflow), or wait for a packaging PR build.
2. Download artifact `holdem-study-windows-installer`.
3. Run the NSIS setup `.exe` (current-user install; WebView2 bootstrapper may download if missing).
4. Launch **Hold'em Study** from the Start menu — no separate CMake/`npm` steps.

### Local packaging (maintainers)

```sh
# build explorer (MSVC), copy sidecar with target triple, then:
cd desktop
npm ci && npm run build
# place explorer-x86_64-pc-windows-msvc.exe under src-tauri/binaries/
npm run tauri:build
```

Until the first green installer artifact exists, do not claim an offline Windows app is generally available.

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
