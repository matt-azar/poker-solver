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

IPC ops are protocol-2 host methods on `solver-engine` (see `desktop/src/engine/transport.ts`). Retired C++ HTTP `/api/*` paths are historical only ([EXPLORER.md](EXPLORER.md)). Soft-gated features: `desktop/src/engine/ipcCapabilities.ts`.

| Backend operation | IPC op(s) | Study UI destination | Limitations | Tests |
| --- | --- | --- | --- | --- |
| Status | `status` | Status bar + solve strip (`gap_series` retained in payload) | Metrics null when unset; Iter n/x every iteration; EV/gap at least every 10 iters | `status.test.ts`; contract smoke |
| Solve | `begin_config` + `solve` | Build workspace + Solve | Reject if already running; empty≠absent bets; short-admit `{accepted,running}` | `client.test.ts`; contract smoke |
| Pause / Stop | `pause`, `cancel` | Solve controls | Chunk boundary before publish; Study stop → host cancel | client + store lifecycle tests |
| Continue | `solve` on open session (no `begin_config`) | Solve controls | Same solution id; browse-only checkpoints disable Continue | store lifecycle; ZR-115 |
| Browse node | `node` | Action history + matrix + combo inspector | One node at a time; root from `root_node_id` | browse vitest; contract smoke |
| Action EV | `values` | Inspector / Analysis | Decision only; mid-train demux by `request_id` | analysis vitest; node-EV scripts |
| Runouts | *(soft-gated)* | Study has no Runouts tab | Host `runouts` not enabled in `ipcCapabilities` | — |
| Next-card picker | chance `cards[]` on `node` | Board buttons → rank×suit picker; line-preserving turn/river via deal-chance ancestor | Rewrites current `pN.t/r` from chance child runout; flop edits and earlier-street swaps after a later card is dealt are unsupported; board blockers marked | `cards.test.ts`; CardPicker |
| Equity (node) | `equity` | Study Equity tab: averages, clickable band filter, OOP vs IP chart, top hands; **Open in Equity** copies reach weights | Check-down (not chip EV); reach-weighted at selected node; buckets + `oop_hands`/`ip_hands` | analysis vitest; contract smoke |
| Equity calculator | `start_equity_job` / `get_equity_job` / `cancel_equity_job` | Equity workspace (2–6 players, Auto/Exact/MC, dead cards, persistence) | No solution required; per-hand/next-card analysis not mounted | desktop Equity UI tests; `scripts/zig/equity-smoke.py` |
| Value / Bluffs | Client join of node `strategy` + `equity` + `values` | Study **Value / Bluffs** tab | After call = equity on Call child of each hand’s max-prob bet/raise; EV via `values` (`comboEv`); Reach is node reach mass | `valueBluffs.test.ts` |
| Categories | `categories` | Categories tab with OOP/IP seat toggle; draws on flop/turn | River made-hand; flop/turn multi-label draws | analysis vitest (ZR-103) |
| Locks | `list_locks` / `put_lock` / `delete_lock` (`scope` node\|line) | Node Locking workspace (Tree → Node locking…) | Default scope is this board; line lock is explicit; all-zero PUT rejected; 0%≠unlock | `locks.test.ts` |
| Strategy edits | `list_strategy_edits` / `put_strategy_edit` / `delete_strategy_edit` | Strategy editor drawer (separate from locks) | Session-only overlays; sum≈1; clear restores CFR average | `strategyEdits.test.ts` (ZR-101) |
| Resolve locked | `resolve_locked` | Solver menu + drawer | New solution + baseline | client IPC tests (ZR-100) |
| Compare | *(soft-gated)* | Compare workspace | Dual-session baseline not available over Zig IPC yet (`compare: false`) | — |
| Save / Open | `save`, `open` | File menu / Build | PSOL + locks; invalid strategy rows rejected before replace | contract smoke; checkpoint vitest |
| Recent / templates / ranges | Tauri FS `library_*` (not engine HTTP) | Library + File menu | Nested `configs/ranges`; flat `configs/templates`; staged via `bundle.resources` | library IPC vitest; `check:library-assets` |
| Config parse | local TS (`streetConfigText`) | Build | street/river text only; street echoes `tree_edits`; no host session mutate | `streetConfigText.test.ts` |
| Memory plan dry-run | `plan_memory` | Collapsible Build preflight shows labeled peak vs budget | Labeled `estimated_peak_bytes`; not RSS; temp compile | TreeLineEditor tests |
| Tree preview / line edits | `tree_preview` | Mounted collapsible Preview tree; Force/Remove/Add size → draft `tree_edits`; same `buildJob` serializer as Solve | Canonical labels; must not wipe loaded Study; failed preview leaves solution | tree-edit vitest |
| Betting tree Save / Open | Client JSON (`holdem-study-betting-tree` v1) in localStorage | Build → Betting tree catalogue | Sizes, caps, `tree_edits` only; flat list (no folders) | `bettingTreeCatalogue` |
| Compare runouts | Client `getNode` + rewrite | Study dock + context-strip | Desktop orchestration; no dedicated host report op | `lineCardReport` + LowerDock |
| Create Build spot from here | Client draft from node + `get_config` | Context strip → Build draft | Midstreet (facing bet / contrib) not supported; asymmetric stacks use `min` | `build/transferFromStudy` |
| Study assistant (AI) | Client-side unified chat + bounded Study evidence tools | Floating Study assistant (menu bar **Assistant**) | OpenAI credentials required in product UI; no autonomous solve / filesystem; pot type required; silent rake → cEV, silent stack → 100bb | assistant domain vitest — see [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md), [ai-context](ai-context/README.md) |

## Numerical labels (do not relabel without math)

- Chip EV (engine / status root EV): root-centered, units `chips`
- Action EV display: local decision EV by default (Fold = 0; `local_offset` from `values`); Global toggle keeps root-centered
- Accuracy: Pio exploitability (average of BR gains = NashConv/2); targets are Accuracy/pot by default (not a cutover Acc wall)
- Equity: fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP); Study filters bands client-side using `oop_hands`/`ip_hands`
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list; `exclusive` false for draw tags
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is `delete_lock`. All-zero PUT rows are rejected by the engine.

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
| Windows NSIS installer | Supported via CI — workflow `Windows Installer` uploads artifact `holdem-study-windows-installer` on `main`. Intentional `v*-windows` tags publish a GitHub Release with stable asset `Holdem-Study-windows-x64-setup.exe`. PREINSTALL stops the UI then force-kills/deletes `solver-engine.exe` (and legacy `holdem-explorer.exe` if present on upgrade); POSTINSTALL requires `solver-engine.exe`, Unblock-Files the UI+engine, writes `engine-setup.txt`, registers HKCU LocalDumps for the UI + sidecar, and seeds `%LOCALAPPDATA%\Holdem Study\diagnostics`. |
| Local crash diagnostics | Help (`?`) shows the diagnostics folder path and offers Open / Copy zip. Sidecar stderr rolls into `engine.log`; **before** Solve/Continue train start a cheap `last-solve.json` + `host-resources.json` (`snapshotKind=pre-solve`) is written; **every** Solve failed / session-dead / kill / ensure-fail / soft solve-RPC fail writes `last-fault.json` and refreshes `host-resources.json` (`snapshotKind=fault`); temporary UI unresponsiveness (status-poll timeout/slow/hung, main-thread stall) appends a ring to `ui-hang-events.json` even when the soft blip recovers; ready handshake writes `session-meta.json`. Packaged path: `%LOCALAPPDATA%\Holdem Study\diagnostics`. No remote Sentry. |
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

1. Ensure `desktop/package.json` / `desktop/src-tauri/tauri.conf.json` version matches the intended cut (current package version is `0.1.6`).
2. On the commit to ship: `git tag -a v0.1.6-windows -m "Holdem Study 0.1.6 (Zig Windows)"` then `git push origin v0.1.6-windows`. Use the version you are cutting, not this example, if it has moved on.
3. Workflow **Windows Installer Release** builds NSIS and attaches assets to the GitHub Release for that tag (stable name + versioned Tauri name).
4. README already points at `/releases/latest/download/Holdem-Study-windows-x64-setup.exe` — no README edit required when the new release is the latest.

Installer product name is `Holdem Study` (no apostrophe) because NSIS shortcut macros reject `Hold'em`. The window title remains `Hold'em Study`.

### Local packaging (maintainers)

```sh
# build Zig solver-engine, copy sidecar with target triple, then:
# Always pin -Dcpu=x86_64_v2 for any Windows sidecar that may leave the builder
# host (bare ReleaseFast follows host CPU and can APPCRASH on older machines).
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
cd desktop
npm ci && npm run build
# place solver-engine-x86_64-pc-windows-msvc.exe under src-tauri/binaries/
npm run tauri:build
```

| Lock / strategy / compare op | UI | Backend |
| --- | --- | --- |
| Apply selected/full lock | Node Locking workspace (paint hand classes) | `put_lock` |
| Unlock | Node Locking workspace | `delete_lock` |
| Apply free-form strategy edit | Strategy editor / inspector | `put_strategy_edit` |
| Clear strategy edits | Strategy editor | `delete_strategy_edit` |
| Resolve locked | Solve/Tree menus + drawer | `resolve_locked` |
| Compare revisions | Compare workspace | soft-gated (`compare: false`) until dual-session IPC lands |

## Validation notes

- Unit: `cd desktop && npm test` (Vitest — browse, locks, strategy edits, status/`gap_series`, cards, analysis helpers, action colors)
- Typecheck: `cd desktop && npx tsc -b`
- Build: `cd desktop && npm run build`
- Engine: `zig build test` (+ `scripts/zig/ready-smoke.py`, `scripts/zig/study-contract-smoke.py`)
- Live: solve via Tauri + `solver-engine` IPC; Status bar shows EV / NashConv / mem (`gap_series` in status payload, no Graphs UI)
- Visual targets: 1440×900 dark/light, 1920×1080 dual-range, 1280×800 compact
- Do not cite deleted C++ HTTP suites or explorer HTTP status codes as current coverage. Re-validate Tauri webview lifecycle, native Open/Save dialogs, and the NSIS packaged install on Windows before a Study release. Full guide: [TESTING.md](auxiliary/engineering/TESTING.md).
- Changing the flop, and changing an earlier street after a later card is dealt, are unsupported. Turn and river card changes keep the betting line when the deal-chance ancestor is known. See [EQUITY.md](EQUITY.md) for check-down equity limits.
