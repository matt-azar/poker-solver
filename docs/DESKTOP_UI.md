# Desktop Study workstation

React study client (`desktop/`) over the Zig `solver-engine` typed-IPC host. Doc index: [README.md](README.md). IPC frames: [EXPLORER.md](EXPLORER.md).

## Stack

| Choice | Decision |
| --- | --- |
| Web client | React 19 + TypeScript + Vite |
| State | Zustand for study and layout. Chrome is dark-only. Query identity lives in the engine client. |
| Engine transport | Zig `solver-engine` typed IPC (protocol 2, inherited pipes via Tauri). |
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

## Study layout

The Study page has three regions. Node navigation (board, betting line, action history) sits above the range matrix. A permanent right rail shows Actions and the combo inspector. The lower dock holds Compare runouts, Equity, Categories, and Value / Bluffs.

Solve, Continue, Pause, and Stop are in the status bar. The bar shows Iter, EV, and Acc. More shows Time, ETA, Rate, Job, and Mem. Chrome is dark-only. Help (`?`) lists Solve (`S`), Stop (`X`), Continue (`C`), and Toggle help (`?`).

## Other entries

| Entry | How to open it |
| --- | --- |
| Public demo | Precomputed packs. `cd desktop && npm run build:public-demo`, then `npm run preview:public-demo`. Local URL `http://127.0.0.1:4173/?demo=flop-explore`. Pages: `https://matt-azar.github.io/poker-solver/?demo=flop-explore`. Details: `desktop/src/demo/README.md`. |
| River beta | Live river solves, five-card boards only. `python3 services/river-beta/run.py --host 127.0.0.1 --port 8787` and `http://127.0.0.1:5173/?river-beta=1`. Details: `services/river-beta/README.md`. |
| Private QA | `cd desktop && npm run preview:scenario`, then `?preview=`. Separate from the public demo. |

## Capability map

IPC ops are protocol-2 host methods on `solver-engine` (`desktop/src/engine/transport.ts`). Frame layout: [EXPLORER.md](EXPLORER.md). Soft-gated features: `desktop/src/engine/ipcCapabilities.ts`.

| Backend operation | IPC op(s) | Study UI destination | Limitations | Tests |
| --- | --- | --- | --- | --- |
| Status | `status` | Status bar (`gap_series` retained in payload) | Visible: Iter, EV, Acc. More: Time, ETA, Rate, Job, Mem. Null when unset. Iter every iteration. EV and gap at least every 10 iterations | `status.test.ts`; contract smoke |
| Solve | `begin_config` + `solve` | Build workspace + Solve | Reject if already running; empty≠absent bets; short-admit `{accepted,running}` | `client.test.ts`; contract smoke |
| Pause / Stop | `pause`, `cancel` | Status bar | Chunk boundary before publish; Study stop → host cancel | client + store lifecycle tests |
| Continue | `solve` on open session (no `begin_config`) | Status bar | Same solution id; browse-only checkpoints disable Continue | store lifecycle; ZR-115 |
| Browse node | `node` | Node nav, matrix, right rail (Actions + combo inspector) | One node at a time; root from `root_node_id` | browse vitest; contract smoke |
| Action EV | `values` | Inspector / Analysis | Decision only; mid-train demux by `request_id` | analysis vitest; node-EV scripts |
| Runouts | — | Study has no Runouts tab. A stored `runouts` or `explorer` tab id opens Equity. | The host has no `runouts` op. | — |
| Next-card picker | chance `cards[]` on `node` | Board buttons → rank×suit picker; line-preserving turn/river via deal-chance ancestor | Rewrites current `pN.t/r` from chance child runout; flop edits and earlier-street swaps after a later card is dealt are unsupported; board blockers marked | `cards.test.ts`; CardPicker |
| Equity (node) | `equity` | Study Equity tab: averages, clickable band filter, OOP vs IP chart, top hands; **Open in Equity calculator** copies reach weights | Check-down (not chip EV); reach-weighted at selected node; buckets + `oop_hands`/`ip_hands`. There is no Runouts tab | analysis vitest; contract smoke |
| Equity calculator | `start_equity_job` / `get_equity_job` / `cancel_equity_job` | Equity workspace (2–6 players, Auto/Exact/MC, dead cards, persistence) | No solution required; per-hand/next-card analysis not mounted | `equityStore` / client vitest; `scripts/zig/equity-calculator-smoke.py` (Study node equity uses `equity-smoke.py`) |
| Value / Bluffs | Client join of node `strategy` + `equity` + `values` | Study **Value / Bluffs** tab | Size toggles keep combos with frequency on the enabled sizes and show that frequency. After call uses equity on the Call child of the highest-frequency enabled size. The table shows 50 rows and can load more. EV comes from `values` (`comboEv`). Reach is node reach mass | `valueBluffs.test.ts` |
| Categories | `categories` | Categories tab with OOP/IP seat toggle; draws on flop/turn | River made-hand; flop/turn multi-label draws | analysis vitest (ZR-103) |
| Locks | `list_locks` / `put_lock` / `delete_lock` (`scope` node\|line) | Node Locking workspace (Tree → Node locking…) | Default scope is this board; line lock is explicit; all-zero PUT rejected; 0%≠unlock | `locks.test.ts` |
| Strategy edits | `list_strategy_edits` / `put_strategy_edit` / `delete_strategy_edit` | Strategy editor drawer (separate from locks) | Session-only overlays; sum≈1; clear restores CFR average | `strategyEdits.test.ts` (ZR-101) |
| Resolve locked | `resolve_locked` | Solve menu, Tree menu, and the lock drawer | New solution + baseline | client IPC tests (ZR-100) |
| Compare | `compare` | Compare workspace | Immutable baseline retained on `resolve_locked`; strategy/EV deltas vs scenario | host + desktop vitest |
| Save / Open | `save`, `open` | File → Save solution… / Open solution…, and Study Save / Open | Save mode **Study** sends `study_only: true` and drops trainer tables. Save mode **Continue** keeps them. PSOL + locks; folders in localStorage index under managed solutions root; Browse disk secondary; invalid strategy rows rejected before replace. Browse-only files disable Continue | contract smoke; checkpoint + `solutionsCatalogue` vitest |
| Recent / templates / ranges | Tauri FS `library_*` (not engine HTTP) | Library + File menu | Nested `configs/ranges`; flat `configs/templates`; staged via `bundle.resources` | library IPC vitest; `check:library-assets` |
| Config parse | local TS (`streetConfigText`) | Build | `street-config 1` only; echoes `tree_edits`; no host session mutate | `streetConfigText.test.ts` |
| Memory plan dry-run | `plan_memory` | Build strip shows Plan peak, Budget, decision count, deal count, pot, and stack | JSON field `estimated_peak_bytes` is the plan. It is not process RSS. Temp compile. | TreeLineEditor tests |
| Tree preview / line edits | `tree_preview` | Preview tree starts collapsed. Decision branches start collapsed. Force/Remove/Add size → draft `tree_edits`. Same `buildJob` serializer as Solve | Canonical labels; must not wipe loaded Study; failed preview leaves solution | tree-edit vitest |
| Portable study job | `holdem-study-job/1` JSON; `holdem-study-cli` `plan` / `solve` / `from-hh` | Build **Export job** / **Import job** | Same `street-config 1` as Solve. `from-hh` accepts a five-card `hand-history 1` file. Import rejects `first-to-act` other than 0. Open can land on `decision.actions`. | `studyJob` vitest; `scripts/zig/holdem-study-cli-smoke.py` |
| Betting tree Save / Open | Client JSON (`holdem-study-betting-tree` v1) in localStorage | Build → Betting tree catalogue | Sizes, caps, `tree_edits` only; flat list (no folders) | `bettingTreeCatalogue` |
| Solutions catalogue | PSOL paths + folder index (`holdem-study-solutions`) | Study Save/Open + Library recent | User folders (multi-level); managed root via Tauri `solutions_*`; no OS picker as primary | `solutionsCatalogue` |
| Compare runouts | Host `line_card_report` (fallback: multi-`getNode`) | Study dock + context-strip | Prefer fat Zig report; legacy multi-getNode kept | `lineCardReport` + LowerDock |
| Value/Bluffs after-call | Host `value_bluffs_post_call` (fallback: bet→Call equity walk) | Value/Bluffs **After call** | Host `hands_by_action` joins each size's Call child. The panel uses the highest-frequency enabled size | `valueBluffsPostCall` |
| Create Build spot from here | Client draft from node + `get_config` | Context strip → Build draft | Midstreet (facing bet / contrib) not supported; asymmetric stacks use `min` | `build/transferFromStudy` |
| Study assistant (AI) | Client-side unified chat + bounded Study evidence tools | Floating Study assistant (menu bar **Assistant**) | OpenAI credentials required in product UI; no autonomous solve / filesystem; pot type required; silent rake → cEV, silent stack → 100bb | assistant domain vitest — see [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md), [ai-context](ai-context/README.md) |
| Algorithm | Host always trains CFR+ (`trainFrozenCfrPlus`) | Settings shows a read-only CFR+ field | Opening Settings sets the draft algorithm to `cfr_plus`. PSOL v4 stores the CFR+ byte only. Train threads from config are capped by `WorkerBudget` (n−2 on 4+ CPUs) | `formats/src/psol_v4.zig`; `host/src/workers.zig` |

## Numerical labels (do not relabel without math)

- Chip EV (engine / status root EV): root-centered, units `chips`
- Action EV display: local decision EV by default (Fold = 0). Zig `values` ships `utility_basis: "local"` primary columns plus dual `root_centered` for Settings Global without refetch; `local_offset` remains for diagnostics / legacy shift
- Matrix cell EV: Zig `values.cell_ev` (and `root_centered.cell_ev`) are posterior-weighted 169-cell aggregates; Study `groupEv` prefers them over per-hand client joins
- Node `action_frequencies` (optional): posterior action mix on `node` when present; ActionSummary / path helpers prefer it over re-aggregating via `groupHands`
- Accuracy: Pio exploitability (average of BR gains = NashConv/2). The Build field is percent of pot (`0.5` sends engine pot fraction `0.005`). Host `solve` compares Accuracy chips with that fraction times the chip pot. Acc walls are not a cutover gate.
- Equity: fraction of pot — not chip EV
- Equity histograms: ten fixed buckets on [0,1]; weights are raw input masses (`equity_distribution` OOP, `ip_equity_distribution` IP); Study filters bands client-side using `oop_hands`/`ip_hands`
- Categories: strategy-weighted reach; seat fractions align with the `categories` name list; `exclusive` false for draw tags
- A 0% action inside a lock row that sums to 1 is a constraint; unlock is `delete_lock`. All-zero PUT rows are rejected by the engine.

## Status

| Slice | State |
| --- | --- |
| Contracts + `EngineClient` | Done |
| Study workspace (node nav, matrix, right rail, lower dock, board picker) | Done |
| Analysis dock + Build + Library | Done — Equity hist + band filter + OOP vs IP chart; Categories made-hand/draws; Value / Bluffs **At this node** and **After call**, with an equity threshold; Library nested range folders |
| Locks + strategy edits | Done |
| Compare | Done — host `compare` + Session baseline snapshot on resolve-locked; `compare: true` in `ipcCapabilities` |
| Desktop packaging (Tauri + NSIS) | Done — unsigned CI artifact; see [Desktop packaging](#desktop-packaging) |
| Visual / a11y / perf polish | Partial — focus-visible, reduced-motion, compact ≤1280, dark-only chrome |

## Desktop packaging

| Item | Status |
| --- | --- |
| Browser-only Study without Tauri | UI shell only. `npm run dev` does not start `solver-engine`. |
| Tauri 2 managed sidecar (`desktop/src-tauri`) | Supported — shell spawns installed `solver-engine` beside the app (absolute path; not `binaries/…`) over inherited-pipe IPC (`ensure_solver_engine` / `solver_engine_request`, protocol 2). The webview loads Vite `dist`. |
| Windows NSIS installer | Supported via CI — workflow `Windows Installer` uploads artifact `holdem-study-windows-installer` on `main`. Intentional `v*-windows` tags publish a GitHub Release with stable asset `Holdem-Study-windows-x64-setup.exe`. PREINSTALL stops the UI then force-kills and deletes `solver-engine.exe`. POSTINSTALL requires `solver-engine.exe`, Unblock-Files the UI+engine, writes `engine-setup.txt`, registers HKCU LocalDumps for the UI + sidecar, and seeds `%LOCALAPPDATA%\Holdem Study\diagnostics`. Follow-on job `windows-installer-e2e` runs Stage A (silent `/S /D=%LOCALAPPDATA%\Holdem Study`, interactive WebView `ensure`+`status`), Stage B (tiny river solve → browse → clear active solution → reopen PSOL → strategy restore → sidecar exit), Stage DelayedReply (packaged WebView held-values concurrency), Stage BlockedWrite, Stage NormalClosePending, and Stage StaleCallAfterReconnect via `scripts/desktop/windows-installer-e2e.ps1`. |
| Local crash diagnostics | Help (`?`) shows the diagnostics folder path and offers Open / Copy zip. Sidecar stderr rolls into `engine.log`; **before** Solve/Continue train start a cheap `last-solve.json` + `host-resources.json` (`snapshotKind=pre-solve`) is written; **every** Solve failed / session-dead / kill / ensure-fail / soft solve-RPC fail writes `last-fault.json` and refreshes `host-resources.json` (`snapshotKind=fault`); temporary UI unresponsiveness (status-poll timeout/slow/hung, main-thread stall) appends a ring to `ui-hang-events.json` even when the soft blip recovers; ready handshake writes `session-meta.json`. Packaged path: `%LOCALAPPDATA%\Holdem Study\diagnostics`. No remote Sentry. |
| Native Open/Save dialogs | Primary Save/Open uses the in-app solutions catalogue (folders). Browse disk remains secondary: browser prompts; Windows Tauri build wires `tauri-plugin-dialog` + `dialog:default` capability; adapter keeps a prompt fallback if the plugin invoke fails |
| Packaged engine ownership | `solver-engine` with `--launch-id` over inherited pipes (protocol 2). Tauri demuxes stdout by `request_id` so Study can issue mid-train `values` while `solve` is in flight. |
| Production CSP | Packaged webview CSP allows `'self'` / Tauri IPC / assets, loopback (`http://127.0.0.1:*`, `http://localhost:*`), and `https://api.openai.com` for the assistant. `devCsp` stays null so `tauri:dev` / HMR are unconstrained. Spawn remains for the owned `solver-engine` sidecar. |
| IPC / contract fixtures | `desktop/src/engine/contracts` + IPC protocol helpers; fixtures under `desktop/src/engine/fixtures`. |
| Code-signed official release | Not yet — CI artifact is unsigned |

### Windows installer (end users)

Prefer the [latest GitHub Release download](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe), or Actions → **Windows Installer** → artifact `holdem-study-windows-installer`.

1. Run `Holdem-Study-windows-x64-setup.exe`. The install is per user. WebView2 may bootstrap if it is missing. Close Holdem Study if it is open. Setup will offer to stop it. Setup stops any leftover `solver-engine`, fails if `solver-engine.exe` is missing after copy, and clears Mark-of-the-Web on the installed exes.
2. Launch **Holdem Study** from the Start menu. The shell starts `solver-engine` with a launch id over inherited pipes and waits for the protocol-2 ready handshake before the Study UI connects. The installed app does not need a local compiler.

### Cutting a Windows Release (maintainers)

Do **not** publish on every `main` merge. When a desktop cut is ready:

1. Ensure `desktop/package.json` / `desktop/src-tauri/tauri.conf.json` version matches the intended cut (current package version is `0.1.8`).
2. On the commit to ship: `git tag -a v0.1.8-windows -m "Holdem Study 0.1.8 (Zig Windows)"` then `git push origin v0.1.8-windows`. Use the version you are cutting, not this example, if it has moved on.
3. Workflow **Windows Installer Release** builds NSIS and attaches assets to the GitHub Release for that tag (stable name + versioned Tauri name).
4. README already points at `/releases/latest/download/Holdem-Study-windows-x64-setup.exe` — no README edit required when the new release is the latest.

Installer product name is `Holdem Study` (no apostrophe) because NSIS shortcut macros reject `Hold'em`. The window title remains `Hold'em Study`.

### Local packaging (maintainers)

```sh
# build Zig solver-engine, copy sidecar with target triple, then:
# On x86_64, omitting -Dcpu already targets x86_64_v2 (ZR-175).
# Windows CI and scripts still pass -Dcpu=x86_64_v2.
# -Dcpu=native follows the builder CPU and can emit AVX-512.
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
| Compare revisions | Compare workspace | `compare` (baseline snapshot vs scenario) |

## Validation notes

- Unit: `cd desktop && npm test` (Vitest — browse, locks, strategy edits, status/`gap_series`, cards, analysis helpers, action colors)
- Typecheck: `cd desktop && npx tsc -b`
- Build: `cd desktop && npm run build`
- Engine: `zig build test` (+ `scripts/zig/ready-smoke.py`, `scripts/zig/study-contract-smoke.py`)
- Live: solve via Tauri + `solver-engine` IPC. The status bar shows Iter, EV, and Acc. More shows Time, ETA, Rate, Job, and Mem. `gap_series` stays in the status payload. There is no Graphs view.
- Visual targets: 1440×900 dark, 1920×1080 dual-range, 1280×800 compact
- Re-validate Tauri webview lifecycle, native Open/Save dialogs, and the NSIS packaged install on Windows before a Study release. Full guide: [TESTING.md](auxiliary/engineering/TESTING.md).
- Changing the flop, and changing an earlier street after a later card is dealt, are unsupported. Turn and river card changes keep the betting line when the deal-chance ancestor is known. See [EQUITY.md](EQUITY.md) for check-down equity limits.
