# Desktop Study workstation

React study client (`desktop/`) over the `explorer` HTTP API. Numerical kernels are unchanged.

## Stack

| Choice | Decision |
| --- | --- |
| Web client | React 19 + TypeScript + Vite |
| State | Zustand for study/layout/theme; query identity in the engine client |
| Engine transport | Typed `EngineClient` over the localhost HTTP API |
| Desktop shell | Tauri 2 + `holdem-explorer` sidecar; browser + Vite proxy still supported |
| Static serving | Prefer `desktop/dist` when present; fall back to legacy `ui/` |
| Legacy UI | Kept under `ui/` for regression and fallback |

The explorer process boundary is the engine API. The Study client is a typed UI over that API; Tauri packages the same client with a sidecar.

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
| Strategy edits | PUT/DELETE `…/strategy-edits` | Hand detail | Strategy editor drawer (separate from locks) | Session-only overlays; sum≈1; clear restores CFR average | HTTP + `strategyEdits.test.ts` |
| Resolve locked | `POST …/resolve-locked` | Resolve + warm-start | Solver menu + drawer | New solution + baseline | HTTP |
| Compare | `GET /api/compare` | Note | Compare workspace | Decision node | HTTP |
| Save / Open | `POST …/save`, `/open` | File fields | File menu / Build | PSOL v2 + locks; browser path fields | checkpoint HTTP |
| Recent | `GET /api/recent-solutions` | Dropdown | Library + File menu | Cap 10 | recent_files |
| Templates / ranges | `GET /api/templates`, `/ranges` | Dropdowns | Build + Library (ranges grouped by folder) | Nested `configs/ranges` folders; template dirs still flat | templates/range lib |
| Config parse | `POST /api/config` | Load config | Build | street/river text only; street echoes `tree_edits` | indirect |
| Memory plan dry-run | `POST /api/plan-memory` | — | Build line editor | Labeled `estimated_peak_bytes`; not RSS | explorer HTTP |
| Tree preview / line edits | `POST /api/tree-preview` | — | Build `TreeLineEditor` Force/Remove/AddSize | Canonical labels; edits into draft → solve | explorer HTTP + tree_edit |
| Study assistant (AI) | Client-side unified chat: help answers + setup interpret → catalogue / generate / interpolate → `SpotDraft` | — | Floating **Help → Study assistant…** (all workspaces) + Build → Setup assistant + Range catalogue | Hideable/movable/resizable window; fake + OpenAI multi-tool (`answer_user` / `emit_study_setup_proposal`); context packs in `docs/ai-context/`; Tauri/localStorage credentials (prototype); pot type required; silent rake → cEV, silent stack → 100bb | `src/domain/{setup,profiles,assistant,help}`, `features/help/StudyAssistantWindow`, credentials — see [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md), [ai-context](ai-context/README.md) |

## Numerical labels (do not relabel without math)

- Chip EV (engine / status root EV): root-centered, units `chips`
- Action EV display: local decision EV by default (Fold = 0; `local_offset` from `/values`); Global toggle keeps root-centered
- Accuracy / Nash gap: NashConv (sum of BR gains); accuracy is NashConv/pot
- Equity: check-down, fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP); Study filters bands client-side using `oop_hands`/`ip_hands`
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list; `exclusive` false for draw tags
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is DELETE. All-zero PUT rows are rejected by the engine.

## Status

| Slice | State |
| --- | --- |
| Contracts + `EngineClient` | Done |
| Study workspace (layout, matrix, inspector, solve controls, board picker) | Done |
| Analysis dock + Build + Library | Done — Equity hist + band filter + composition; Categories made-hand/draws; Library nested range folders |
| Locks + Strategy edits + Compare | Done |
| Desktop packaging (Tauri + NSIS) | Done — unsigned CI artifact; see [Desktop packaging](#desktop-packaging) |
| Visual / a11y / perf polish | Partial — focus-visible, reduced-motion, compact ≤1280, light/dark themes |

## Desktop packaging

| Item | Status |
| --- | --- |
| Browser Study client + localhost `explorer` | Supported |
| Vite `/api` proxy in `npm run dev` | Supported |
| `explorer` serving `desktop/dist` | Supported |
| Tauri 2 managed sidecar (`desktop/src-tauri`) | Supported — shell spawns installed `holdem-explorer` beside the app (absolute path; not `binaries/…`) on port 8765, waits until the port accepts connections, exposes `ensure_engine` for Reconnect; webview loads Vite `dist`. Explorer responses include CORS (`Access-Control-Allow-Origin: *` + OPTIONS preflight) so the webview origin (`https://tauri.localhost`) can `fetch` `http://127.0.0.1:8765` |
| Windows NSIS installer | Supported via CI — workflow `Windows Installer` uploads artifact `holdem-study-windows-installer`. Intentional `v*-windows` tags publish a GitHub Release with stable asset `Holdem-Study-windows-x64-setup.exe` (plus the versioned Tauri NSIS name). POSTINSTALL requires `holdem-explorer.exe`, Unblock-Files the UI+engine, writes `engine-setup.txt`. Packaged explorer uses the static MSVC CRT |
| Native Open/Save dialogs | Browser prompts; Tauri adapter uses `@tauri-apps/plugin-dialog` when present (prompt fallback) |
| Code-signed official release | Not yet — CI artifact is unsigned |

### Windows installer (end users)

Prefer the [latest GitHub Release download](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe), or Actions → **Windows Installer** → artifact `holdem-study-windows-installer`.

1. Run `Holdem-Study-windows-x64-setup.exe` (current-user install; WebView2 may bootstrap if missing). Setup fails loudly if the engine sidecar is missing and clears Mark-of-the-Web on the installed exes.
2. Launch **Holdem Study** from the Start menu — the shell starts `holdem-explorer` on `127.0.0.1:8765` before the Study UI polls. No CMake/`npm` required.

### Cutting a Windows Release (maintainers)

Do **not** publish on every `main` merge. When a desktop cut is ready:

1. Ensure `desktop/package.json` / `desktop/src-tauri/tauri.conf.json` version matches the intended cut (e.g. `0.1.1`).
2. On the commit to ship: `git tag -a v0.1.1-windows -m "Holdem Study 0.1.1 (Windows)"` then `git push origin v0.1.1-windows`.
3. Workflow **Windows Installer Release** builds NSIS and attaches assets to the GitHub Release for that tag (stable name + versioned Tauri name).
4. README already points at `/releases/latest/download/Holdem-Study-windows-x64-setup.exe` — no README edit required when the new release is the latest.

Installer product name is `Holdem Study` (no apostrophe) because NSIS shortcut macros reject `Hold'em`. The window title remains `Hold'em Study`.

### Local packaging (maintainers)

```sh
# build explorer (MSVC), copy sidecar with target triple, then:
cd desktop
npm ci && npm run build
# place holdem-explorer-x86_64-pc-windows-msvc.exe under src-tauri/binaries/
npm run tauri:build
```

| Lock / strategy / compare op | UI | Backend |
| --- | --- | --- |
| Apply selected/full lock | Lock drawer / inspector | `PUT …/locks` |
| Unlock | Lock drawer / inspector | `DELETE …/locks` |
| Apply free-form strategy edit | Strategy editor / inspector | `PUT …/strategy-edits` |
| Clear strategy edits | Strategy editor | `DELETE …/strategy-edits` |
| Resolve locked | Solve/Tree menus + drawer | `POST …/resolve-locked` |
| Compare revisions | Compare workspace | `GET /api/compare` |

## Validation notes

- Unit: `cd desktop && npm test` (browse, locks, strategy edits, status/`gap_series`, cards, analysis helpers, action colors)
- Build: `cd desktop && npm run build`
- Live: solve against `explorer`; Graphs read `status.gap_series`; Status bar shows EV / NashConv / mem
- Visual targets: 1440×900 dark/light, 1920×1080 dual-range, 1280×800 compact
