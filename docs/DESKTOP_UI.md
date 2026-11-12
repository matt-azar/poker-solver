# Desktop Study workstation

React study client (`desktop/`) over the Zig `solver-engine` typed-IPC host. Doc index: [README.md](README.md). The C++ HTTP explorer is retired: [EXPLORER.md](EXPLORER.md).

## Stack

| Choice | Decision |
| --- | --- |
| Web client | React 19 + TypeScript + Vite |
| State | Zustand for study/layout/theme; query identity in the engine client |
| Engine transport | Zig `solver-engine` typed IPC only (protocol 2, inherited pipes via Tauri). No `holdem-explorer` / `:8765` shipping path. |
| Desktop shell | Tauri 2 + `solver-engine` IPC sidecar |
| Static UI | Vite `dist` loaded by the Tauri webview |

The Study client is a typed UI over the IPC ops; Tauri owns the sidecar lifecycle.

## Development

```sh
# terminal 1 — Zig engine
zig build -Doptimize=ReleaseFast

# terminal 2 — Tauri Study shell (spawns solver-engine)
cd desktop && npm ci && npm run tauri dev
```

Browser-only `npm run dev` does not start an engine.

## Capability map

| Backend operation | Endpoint | Legacy UI (`legacy/ui/`) | New Study UI destination | Limitations | Tests |
| --- | --- | --- | --- | --- | --- |
| Status | `GET /api/status` | Poll 250ms | Status bar + solve strip (`gap_series` retained in payload) | Metrics null when unset; Iter n/x every iteration; EV/gap at least every 10 iters | `status.test.ts`; `test_explorer_http.cpp`, `test_session.cpp` |
| Solve | `POST /api/solve` | Setup form | Build workspace + Solve | 409 if running; empty≠absent bets | HTTP + session |
| Pause / Stop | `POST /api/pause`, `/stop` | Buttons | Solve controls | Chunk boundary before publish | session; HTTP stop |
| Continue | `POST …/continue` | Continue | Solve controls | Same solution id | HTTP |
| Browse node | `GET …/nodes/{id}` | Tree + matrix | Action history + matrix + combo inspector | One node at a time; root from `root_node_id` | browse + HTTP |
| Action EV | `GET …/values` | Calculate EVs | Inspector / Analysis | Decision only; may 202 | value worker |
| Runouts | `GET …/runouts` | — | Engine endpoint remains; Study has no Runouts tab | Chance / street only | engine; sparse HTTP |
| Next-card picker | chance `cards[]` (+ legacy `children`) | Card grid | Board buttons → rank×suit picker; line-preserving turn/river via deal-chance ancestor | Rewrites current `pN.t/r` from chance child runout (400/404 → child id); flop edits and earlier-street swaps after a later card is dealt are unsupported; board blockers marked | `cards.test.ts`; CardPicker |
| Equity (node) | `GET …/equity` | Averages + hist | Study Equity tab: averages, clickable band filter, OOP vs IP chart, top hands; **Open in Equity** copies reach weights | Check-down (not chip EV); buckets + `oop_hands`/`ip_hands` | equity tests; `analysis.test.ts` |
| Equity calculator | `POST/GET /api/equity/jobs…` | — | Equity workspace (2–6 players, Auto/Exact/MC, dead cards, persistence) | No solution required; per-hand/next-card analysis not mounted | `equity_calculator_tests`; desktop Equity UI |
| Value / Bluffs | Client join of node `strategy` + `/equity` (node or Call-child) + `/values` for EV | — | Study **Value / Bluffs** tab: betting hands with equity vs user threshold (default 30%; toggle exclusive &lt; bluffs / &gt; value), bet freq ≥ 1% (settings), reach ≥ 0.005 (settings), sortable columns Hand / Bet % / EV / Eq / Reach / Size; gear settings menu; row selects matrix cell; **At this node** / **After call** toggle | After call = `/equity` on Call child of each hand’s max-prob bet/raise; EV is mixed chip EV via existing `/values` (`comboEv`, Study local/global basis); Reach is node reach mass (2 decimals); bare All-in counts; no new explorer API | `valueBluffs.test.ts` |
| Categories | `GET …/categories` | Table | Categories tab with OOP/IP seat toggle; draws on flop/turn | River made-hand; flop/turn multi-label draws | hand categories; `analysis.test.ts` |
| Locks | PUT/DELETE `…/locks` (`scope` node\|line) | Hand detail | Dedicated Node Locking workspace (Tree → Node locking…): strategy-colored 13×13 paint grid, frequency sliders, Lock selected (this board) + Lock line across runouts, overall/selected bars, Save & Close; Hands panel is read-only | Default scope is this board; line lock is explicit; all-zero PUT rejected; 0%≠unlock | HTTP + `locks.test.ts` |
| Strategy edits | PUT/DELETE `…/strategy-edits` | Hand detail | Strategy editor drawer (separate from locks) | Session-only overlays; sum≈1; clear restores CFR average | HTTP + `strategyEdits.test.ts` |
| Resolve locked | `POST …/resolve-locked` | Resolve + warm-start | Solver menu + drawer | New solution + baseline | HTTP |
| Compare | `GET /api/compare` | Note | Compare workspace | Decision node | HTTP |
| Save / Open | `POST …/save`, `/open` | File fields | File menu / Build | PSOL v2 + locks; browser path fields | checkpoint HTTP |
| Recent | `GET /api/recent-solutions` | Dropdown | Library + File menu | Cap 10 | recent_files |
| Templates / ranges | `GET /api/templates`, `/ranges` | Dropdowns | Library (ranges grouped by folder). Build Catalogue uses Vite-bundled seat×action packs (`configs/range-profiles`), not these APIs | Nested `configs/ranges` folders; flat `configs/templates`; packaged Study stages both via Tauri `bundle.resources` and sets `POKER_SOLVER_TEMPLATES` / `POKER_SOLVER_RANGES` on the sidecar | templates/range lib; `check:library-assets` |
| Config parse | `POST /api/config` | Load config | Build | street/river text only; street echoes `tree_edits` | indirect |
| Memory plan dry-run | `POST /api/plan-memory` (also nested `plan` on tree-preview) | Build Preview tree | Collapsible Build preflight shows labeled peak vs budget | Labeled `estimated_peak_bytes`; not RSS | explorer HTTP + TreeLineEditor |
| Tree preview / line edits | `POST /api/tree-preview` | Build Preview tree | Mounted collapsible Preview tree; Force/Remove/Add size → draft `tree_edits`; same `buildJob` serializer as Solve | Canonical labels; stale preview clears on draft change; failed preview leaves Study solution | explorer HTTP + tree_edit |
| Betting tree Save / Open | Client JSON (`holdem-study-betting-tree` v1) in localStorage | — | Build → Betting tree: Save tree / Open tree opens a one-level in-app catalogue (save / open / rename / delete; no OS file dialog) | Sizes, caps, `tree_edits` only; leaves board/ranges/stop alone; flat list (no folders) | `bettingTreeCatalogue` + `BettingTreeCatalogue` |
| Compare runouts | Client `getNode` + rewrite | Study dock tab + context-strip button (right side, beside Save / Open) | Same betting line across turn/river cards; line uses the study path abbreviation (`x/b20/c - x`); suit symbols; EV/equity cells use a red-to-green fill; seat labeled OOP or IP | Desktop orchestration; no dedicated explorer report endpoint yet | `lineCardReport` + LowerDock |
| Create Build spot from here | Client draft from node + `GET …/config` | Context strip | Street-start turn/river OOP decision → Build draft (raw reaches, pot, effective stack); donk baked into starting bets; root actions checked via tree-preview | Midstreet (facing bet / contrib) not supported; asymmetric stacks use `min` | `build/transferFromStudy` |
| Study assistant (AI) | Client-side unified chat: help answers + setup interpret → catalogue / generate / interpolate → `SpotDraft`; bounded Study evidence tools (node strategy / bluffs / selected hand) via analysis scheduler | — | Floating Study assistant (menu bar **Assistant** toggle) | OpenAI credentials required in product UI; fake provider retained for tests only; tools (`answer_user` / `emit_study_setup_proposal` / `query_node_strategy` / `list_bluff_candidates` / `query_selected_hand_analysis`); context packs in `docs/ai-context/` (generated from `docs/ai-context/source/`, CI `check:ai-context`); no autonomous solve / filesystem; pot type required; silent rake → cEV, silent stack → 100bb; auto-write with conflict Apply | `src/domain/{setup,profiles,assistant}` (help clients under `assistant/help/`), `features/assistant/StudyAssistantWindow`, credentials — see [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md), [ai-context](ai-context/README.md) |

## Numerical labels (do not relabel without math)

- Chip EV (engine / status root EV): root-centered, units `chips`
- Action EV display: local decision EV by default (Fold = 0; `local_offset` from `/values`); Global toggle keeps root-centered
- Accuracy: Pio exploitability (average of BR gains = NashConv/2); targets are Accuracy/pot by default
- Equity: fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP); Study filters bands client-side using `oop_hands`/`ip_hands`
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list; `exclusive` false for draw tags
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is DELETE. All-zero PUT rows are rejected by the engine.

## Status

| Slice | State |
| --- | --- |
| Contracts + `EngineClient` | Done |
| Study workspace (layout, matrix, inspector, solve controls, board picker) | Done |
| Analysis dock + Build + Library | Done — Equity hist + band filter + OOP vs IP chart; Categories made-hand/draws; Value / Bluffs Mode A/B (node vs after-call equity; &lt;/&gt; threshold); Library nested range folders |
| Locks + Strategy edits + Compare | Done |
| Desktop packaging (Tauri + NSIS) | Done — unsigned CI artifact; see [Desktop packaging](#desktop-packaging) |
| Visual / a11y / perf polish | Partial — focus-visible, reduced-motion, compact ≤1280, light/dark themes |

## Desktop packaging

| Item | Status |
| --- | --- |
| Browser-only Study without Tauri | UI shell only — no engine (C++ `holdem-explorer` / Vite `:8765` proxy removed) |
| Tauri 2 managed sidecar (`desktop/src-tauri`) | Supported — shell spawns installed `solver-engine` beside the app (absolute path; not `binaries/…`) over inherited-pipe IPC (`ensure_solver_engine` / `solver_engine_request`, protocol 2). The webview loads Vite `dist`. |
| Windows NSIS installer | Supported via CI — workflow `Windows Installer` uploads artifact `holdem-study-windows-installer` (also on `zig-rewrite`). Intentional `v*-windows` tags publish a GitHub Release with stable asset `Holdem-Study-windows-x64-setup.exe`. PREINSTALL stops the UI then force-kills/deletes `solver-engine.exe` (and legacy `holdem-explorer.exe` if present on upgrade); POSTINSTALL requires `solver-engine.exe`, Unblock-Files the UI+engine, writes `engine-setup.txt`. |
| Native Open/Save dialogs | Browser prompts; Windows Tauri build wires `tauri-plugin-dialog` + `dialog:default` capability; adapter keeps a prompt fallback if the plugin invoke fails |
| Packaged engine ownership | `solver-engine` with `--launch-id` over inherited pipes (protocol 2). Tauri demuxes stdout by `request_id` so Study can issue mid-train `values` while `solve` is in flight. No HTTP explorer fallback. |
| Production CSP | Packaged webview CSP allows `'self'` / Tauri IPC / assets, loopback (`http://127.0.0.1:*`, `http://localhost:*`), and `https://api.openai.com` for the assistant. `devCsp` stays null so `tauri:dev` / HMR are unconstrained. Spawn remains for the owned `solver-engine` sidecar. |
| IPC / contract fixtures | `desktop/src/engine/contracts` + IPC protocol helpers; fixtures under `desktop/src/engine/fixtures`. |
| Code-signed official release | Not yet — CI artifact is unsigned |

### Windows installer (end users)

Prefer the [latest GitHub Release download](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe), or Actions → **Windows Installer** → artifact `holdem-study-windows-installer`.

1. Run `Holdem-Study-windows-x64-setup.exe` (current-user install; WebView2 may bootstrap if missing). Close Holdem Study if it is open (setup will offer to stop it). Setup stops any leftover `solver-engine` (and legacy `holdem-explorer`), fails loudly if `solver-engine.exe` is missing after copy, and clears Mark-of-the-Web on the installed exes.
2. Launch **Holdem Study** from the Start menu. The shell starts `solver-engine` with a launch id over inherited pipes and waits for the protocol-2 ready handshake before the Study UI connects. No CMake or npm required.

### Cutting a Windows Release (maintainers)

Do **not** publish on every `main` merge. When a desktop cut is ready:

1. Ensure `desktop/package.json` / `desktop/src-tauri/tauri.conf.json` version matches the intended cut (current package version is `0.1.2`).
2. On the commit to ship: `git tag -a v0.1.2-windows -m "Holdem Study 0.1.2 (Windows)"` then `git push origin v0.1.2-windows`. Use the version you are cutting, not this example, if it has moved on.
3. Workflow **Windows Installer Release** builds NSIS and attaches assets to the GitHub Release for that tag (stable name + versioned Tauri name).
4. README already points at `/releases/latest/download/Holdem-Study-windows-x64-setup.exe` — no README edit required when the new release is the latest.

Installer product name is `Holdem Study` (no apostrophe) because NSIS shortcut macros reject `Hold'em`. The window title remains `Hold'em Study`.

### Local packaging (maintainers)

```sh
# build Zig solver-engine, copy sidecar with target triple, then:
zig build -Doptimize=ReleaseFast
cd desktop
npm ci && npm run build
# place solver-engine-x86_64-pc-windows-msvc.exe under src-tauri/binaries/
npm run tauri:build
```

| Lock / strategy / compare op | UI | Backend |
| --- | --- | --- |
| Apply selected/full lock | Node Locking workspace (paint hand classes) | `PUT …/locks` |
| Unlock | Node Locking workspace | `DELETE …/locks` |
| Apply free-form strategy edit | Strategy editor / inspector | `PUT …/strategy-edits` |
| Clear strategy edits | Strategy editor | `DELETE …/strategy-edits` |
| Resolve locked | Solve/Tree menus + drawer | `POST …/resolve-locked` |
| Compare revisions | Compare workspace | `GET /api/compare` |

## Validation notes

- Unit: `cd desktop && npm test` (browse, locks, strategy edits, status/`gap_series`, cards, analysis helpers, action colors)
- Build: `cd desktop && npm run build`
- Engine: `zig build test` (+ optional `scripts/build.sh` ready smoke)
- Live: solve via Tauri + `solver-engine` IPC; Status bar shows EV / NashConv / mem (`gap_series` in status payload, no Graphs UI)
- Visual targets: 1440×900 dark/light, 1920×1080 dual-range, 1280×800 compact
- C++ `poker_http_tests` / spawned `explorer` were removed on `zig-rewrite`. Re-validate Tauri webview lifecycle, native Open/Save dialogs, and the NSIS packaged install on Windows before a Study release.
- Changing the flop, and changing an earlier street after a later card is dealt, are unsupported. Turn and river card changes keep the betting line when the deal-chance ancestor is known. See [EQUITY.md](EQUITY.md) for check-down equity limits.
