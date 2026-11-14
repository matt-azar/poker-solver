# Lessons for future agents

Mistakes, friction, and correctness traps observed in this repository’s history and in multi-agent cloud runs. **Read this file at the start of every coding task** (not only when spawning siblings or touching solvers). Root `AGENTS.md` and `.cursor/rules/parallel-agents.mdc` point here; keep them in sync when the short digest changes.

Related always-on rule: `.cursor/rules/parallel-agents.mdc`. Licensing: `.cursor/rules/licensing.mdc`. Refresh playbook: [`AGENT_LESSONS_REFRESH.md`](AGENT_LESSONS_REFRESH.md).

**`main` product path (owner GO 2026-11-12; Zig cutover):** Study ships Zig `solver-engine` typed IPC only. The C++ `holdem-explorer` / CMake tree, HTTP `:8765` fallbacks, and dual-sidecar packaging are removed. Sections below that mention CMake / `explorer` / `poker_http_tests` are **historical traps** from the C++ era — do not treat them as a mandate to restore those paths.

---

## 1. Parallel Cursor agents (operational friction)

### Hard rules

1. **One writer per tree.** Delegated Task / best-of-n runners may still write into shared `/workspace` even when told to use an isolated worktree. Do not `git checkout`, reset, or commit on `/workspace` while siblings run unless you have confirmed they never touch that path.
2. **Disjoint file ownership.** Assign path prefixes per agent. Serialize shared manifests (`build.zig`, `desktop/src-tauri/tauri.conf.json`, Tauri `solver_engine.rs` spawn/IPC, `host/src/dispatch.zig`, `desktop/src/engine/client.ts` / `transport.ts`) or let only the parent edit them. Historical CMake / `explorer_main.cpp` ownership rules apply only on pre-cutover trees.
3. **Parent owns forge writes.** Subagents often lack `ManagePullRequest` and must not use `gh` to create/update PRs. After a sibling pushes, the parent opens/updates the PR and subscribes CI.
4. **Snapshot before splitting.** If the tree is interleaved, commit everything onto `cursor/wip-…-<run-suffix>`, then path-checkout onto clean feature branches from the correct base (`main`).
5. **Re-check `git status` before every commit.** Restore unexpected paths with `git checkout HEAD -- <path>`.
6. **Scope shared harness edits.** A WIP snapshot’s `build.zig` / host dispatch / desktop EngineClient will list every agent’s ops. Trim to this branch only.

### What went wrong (concrete)

| Failure | Symptom | Fix |
| --- | --- | --- |
| Shared-workspace pollution | Files appear mid-turn; missing headers; SKIP/assertion counts flip | Treat `/workspace` as contended; verify worktree paths |
| Interleaved milestones | One dirty tree mixes M2/M6/M8; CMake lists both `hand_categories.cpp` and `test_payoff.cpp` | WIP snapshot → path-limited feature branches |
| Parent + agent same branch | Confusing “ahead by 1”, double commits | One owner per branch name |
| Subagent no PR | Branch on origin, no GitHub PR | Parent `ManagePullRequest` immediately |
| Wrong docs from WIP | M8 wording on an M2 PR | Edit docs from `origin/main`, apply only this milestone’s rows |
| Bad stack base | Explorer five-card on plain `main` without StreetBatch five-card | Base on dependency branch or include its commits |

### Suggested sibling prompt clauses

```text
Work only under this worktree path: <absolute path>.
Do not modify /workspace.
Touch only these paths: <list>.
Do not edit build.zig, tauri.conf.json, solver_engine.rs, host/src/dispatch.zig,
  or desktop/src/engine/{client,transport}.ts unless listed; if you must, add only your ops.
Branch: cursor/<name>-<run-suffix> from <exact base ref>
  (use the suffix required by this cloud run, e.g. -ce85 / -c006).
  Product tip base is origin/main.
Push with git push -u origin <branch>.
Do not open a PR (parent will ManagePullRequest).
Do not change LICENSE.
Report: tip SHA, files touched, test command + counts, compare URL.
```

### Recovery checklist (interleaved tree)

1. Inventory with `git status` / `git diff --stat`.
2. Commit all dirty + untracked onto `cursor/wip-<topic>-<run-suffix>`.
3. For each feature: branch from the product tip (`origin/main`).
4. `git checkout wip -- <only that feature’s files>`.
5. Trim shared manifests, dispatch, EngineClient, and docs.
6. `zig build` + `zig build test`; desktop `npx tsc -b` / focused vitest; fix.
7. Push; parent opens PR; subscribe CI.
8. Keep WIP for archaeology until splits are pushed.

### Post-merge / branch hygiene

- **Follow-ups on a merged head never reach `main`.** If more work lands on a branch after its PR merged (#208), rebase onto `origin/main` as a **new** PR. Do not assume the old head is still mergeable.
- Closed/merged PR heads and orphan `cursor/*` branches are pruned daily (`.github/workflows/prune-stale-branches.yml`, #199). Finish and open the PR before assuming the remote branch will stay.

---

## 2. Architecture and module boundaries

### Zig `solver-engine` IPC (current product)

Packaged Study talks to Zig over **typed IPC** (protocol 2, inherited stdin/stdout pipes via Tauri). There is no shipping HTTP `:8765` / `holdem-explorer` path on `main` (#286–#287).

| Trap | Symptom | Do / Don't |
| --- | --- | --- |
| HTTP fallthrough while IPC is active | `Engine unreachable: Failed to fetch` after a healthy sidecar spawn (#288) | **Don't** `fetch("")` or hit `:8765` from Library/Study when IPC transport is selected. Block HTTP fallthrough. |
| Library needs live pipes | Templates/ranges fail until solve works | Serve templates/ranges via **Tauri FS** (`library_*`) without requiring a healthy engine session (#288, #289) |
| Console PE under GUI shell | Blank console; closing it kills the sidecar and bricks Study (#290) | Link `solver-engine` with Windows **GUI subsystem**; pass `CREATE_NO_WINDOW` on spawn as defense in depth. Keep CLI tools Console. |
| `reg.exe` LocalDumps on setup | Several brief console flashes on every Windows Study start (not the sidecar) | `diagnostics::register_local_dumps` spawns Console-subsystem `reg add` — pass `CREATE_NO_WINDOW` (and null stdio). Sidecar already has the flag; do not remove it. |
| AVX-512 default CPU | `0xc000001d` illegal instruction on older hosts | Pin `zig build -Dcpu=x86_64_v2` (scripts + CI); override with `ZIG_CPU` (#288, #289) |
| stderr not drained | Windows ready handshake deadlocks when parent redirects stderr | Drain sidecar stderr during spawn/ready (#288) |
| Sync Tauri IPC commands | Slow `values`/compile blocks native UI thread; Status/Stop/Close cannot run | `ensure_solver_engine` / `solver_engine_request` / `kill_solver_engine_cmd` are **async**; dedicated stdin writer + stdout reader per launch; kill handle independent of writer; no per-invoke `spawn_blocking` for pipe I/O. Ready handshake must not block Tauri setup. Packaged Windows gate: `scripts/desktop/ipc-async-acceptance.ps1` + `ipc-test-sidecar`. |
| `Cargo.toml` deps after `[target.'cfg(windows)'.dependencies]` | Linux `use tokio` / pin crates “undeclared” | Keys after a target table belong to that table. Keep shared pins (incl. `tokio`) under `[dependencies]`. |
| Lifecycle mutex around whole RPC | Mid-train `values` stalls behind `solve` | Hold lifecycle mutex only for spawn/take/kill; dedicated writer thread (not a stdin mutex held across awaits); demux stdout by `request_id` (#282) |
| Timeout kills train | One slow RPC aborts an in-flight solve | Kill on write/`Broken pipe`/shutdown; **don't** nuke train on a single RPC timeout (#289) |
| IPC stdin starved mid-flop | Packaged Windows Solve → `status-poll-hung` / `session-dead` while sidecar is **hot CPU + growing RSS** (not a crash) | Root cause: MT train uses too many cores and/or begin frees a GiB tree under `session.mu`, so status never replies in time. Cap train threads (`WorkerBudget.maxTrainThreads` = n−2 on ≥4 CPUs), prefer IPC thread scheduling on Windows, free detached solutions **after** unlock, and never nest `budget.live` under `session.mu`. Soft status timeouts during building/solving must not hung-kill; do **not** “fix” poll timeouts as the fix. |
| Preview mutates session | Build Preview / plan-memory wipes a loaded Study | `tree_preview` / `plan_memory` must temp-compile **without** `begin_config` / `clearSolution` (#295) |
| Status omits iterations / sync begin | Packaged flop Solve looks frozen at “Solving — 0” until done | Host `status` must publish `iterations` + `iterations_requested`; run `begin_config` **off** the stdin loop so polls stay live during flop compile; Study awaits admit only and polls for progress (ZR-120) |
| Continue re-begins config | Continue broken after pause | `continueSolve` = host `solve` on the **open** session (no `begin_config`); mint a fresh job id (#292) |
| Study `stop` ≠ host cancel | Stop leaves jobs running | Map Study stop → host job **cancel** (#284) |
| Cancel ignores job id | Stale Stop kills `train-current` / lost solutions | Register begin+train `active_job_id` before dispatch; `cancel`/`pause` match that id under `job_mu`; idempotent for the live id; `not_running` for completed/unknown ids — **never** `requestStop()` / pause-latch for a stale id. Clear active identity on worker terminal. |
| Hung kill ignores launch id | Watchdog/UI kill after Reconnect tears down engine B | `kill_solver_engine_cmd` requires `expected_launch_id`; mismatch / empty id is a no-op or error — never blind-kill. Capture the hung launch id before clearing transport; clear IPC transport only when it still names that launch. |
| Analysis supersession detaches | Orphan workers UAF HostState on teardown; clear shared `analysis_running` / WorkerBudget while newer work is live | Park prior analysis threads on a bounded orphan list and **join all** on teardown (never `detach`). Gen-scope `finishAnalysisSlot` / budget return. Release publish lease before the blocking stdout write once the reply body is owned. |
| Fake node equity | Equity looks like root on every node | Study node equity must **replay reach weights** (own actions × card removal) then check-down on the node board (#293). Calculator jobs (`start_equity_job`…) are a **different** IPC surface (#297). |
| Starting-board equity gate (fixed) | Historical desktop 501 / `node_equity_unsupported` on non-root equity | Reach-aware host equity shipped (#291→#293); do not reintroduce the 501 gate |
| Tree-edit path tokens | Soft-unapplied edits / wrong AddSize | Match compact↔display labels (Bet/Raise/all-in); Apply AddSize with pot-cap / all-in / min-raise rules; report unapplied edits (#296) |
| `parseConfig` over host | Library Apply template 501 | Street-config parse may stay **local TS** (no host op, no session mutation) (#294) |

**Pointers:** `docs/DESKTOP_UI.md`, `host/`, `engine/`, `desktop/src-tauri/src/solver_engine.rs`, PRs #254/#280–#297.

### Zig frozen CFR / rematch correctness

- **Heap-stable runout ranks:** do not store `RunoutRanks` by value in a hash map and hand out pointers — concurrent inserts rehash and UAF under MT Acc-stop (#266). Store heap-stable pointers; fill off-lock.
- **Locks on train:** freeze / floorAndFreeze must `findForRunout` + `applyLockToStrategy` after regret matching (#278). Having `LockSet` types is not enough.
- **Frozen-root action EV:** Study latency path may use `response_walk`, but reported aev must match conditional **`Q_i`** (divide CF raw by `prior * joint_scale * open`) (#279).
- **Flop-scale aev reach:** non-root `actionValuesDealByDeal` must weight by opponent betting-path reach for **`card_mode ≠ 0`** ancestors, and skip hole pairs that collide with fixed turn/river (#277).
- Persist chance workers / ranks across Session train/eval when required (#270, #276); don't respawn every chance if the pool is Session-scoped.
- Persist `FrozenCtx` carefully across Acc-stop cycles; Acc-stop that rebuilds ranks every iter stresses the map (#266).

**Do:** Pin rematches against tip C++ / deal-by-deal twins before claiming Study parity.  
**Don't:** Treat soft Acc-stop wall-clock scoreboard wins as correctness GO.

### One production postflop engine (M6)

A flop, turn, and river are **one** betting tree with two, one, or zero cards left. On `main`, production Study uses the Zig Session frozen public-tree path for all three board lengths.

| Board | Current product path | Historical C++ reference |
| --- | --- | --- |
| 3, 4, or 5 cards | Zig Session / `solver-engine` IPC | `StreetBatchSolver` vs `StreetGame` + `CfrTrainer` (`--reference`) |

**Do:** Keep five-card rematch/oracle pins in `zig build test`.  
**Don't:** Reintroduce C++ `RiverBatchSolver` / `holdem-explorer` as a shipping path.  
**Pointers:** `docs/ARCHITECTURE.md`, `docs/auxiliary/planning/ROADMAP.md` M6, `engine/`.

### `*Game` vs `*Batch`

- Zig Session / frozen public-tree CFR — **current** production default for flop/turn/river Study.
- Historical C++: `RiverGame` / `StreetGame` (deal enumeration oracle), `StreetBatchSolver` (public tree), `RiverBatchSolver` (oracle/legacy only).

**Do:** Pin public-tree changes against rematch/oracle fixtures (`zig build test`) before scaling.  
**Don't:** “Optimize” by changing only the batch/frozen kernel without an oracle gate.

### Archive: `include/` must not depend on UI trees (pre-#287)

Historical C++ layout: engine/session under `include/game|solver|explorer|poker`; HTTP in `src/cli/explorer_main.cpp` + `src/explorer/`. That tree is removed. Zig keeps engine code under `engine/` / `host/` with no desktop imports.

**Don't:** reintroduce a C++ `include/` product tree or couple engine modules to `desktop/`.

### Utility sign and player index

- River/street: **player 0 = OOP**, terminal utility is **P0 net chips** (root-centered); IP is the negation under chip zero-sum.

**Do:** Treat reported solver EV as OOP/`u0` unless a dual-payoff API says otherwise.  
**Pointers:** `docs/RIVER.md`, `docs/MATHEMATICS.md`, Zig Session / CFR modules under `engine/`.

### Frozen pass, threads, CFR+ floor

- `--threads N>1` requires `--frozen`; per-deal walk stays serial.
- Parallelism splits the **first future public card** only (turn→rivers, flop→turns).
- Public frozen path: vanilla CFR, CFR+, fixed DCFR(1.5,0,2), and PCFR+ (not Linear CFR).
- CFR+: sum counterfactual regret across the frozen pass, then **floor only the updating player**; leave the opponent table alone.
- PCFR+: same alternating schedule and CFR+ floor / linear own-reach average; match on \(R+m\) with \(m=\) last instantaneous CF regret (cold-start zeros \(m\); PSOL v3 may restore \(m\), v1/v2 reload zeros \(m\)).
- DCFR: same alternating frozen passes; after each pass **discount** the updating player's full regret row (signed; no CFR+ floor) with `t^α/(t^α+1)` on positives and `t^β/(t^β+1)` on non-positives; average with `t^γ` own-reach (defaults α=1.5, β=0, γ=2). PSOL v3 stores the actual params used. Reject DCFR and PCFR+ on the non-frozen walk and on legacy `RiverBatchSolver`.

**Pointers:** `docs/STREETS.md` (frozen threads), Zig frozen CFR under `engine/`, historical commits `9e0d87d`, `6a597df`, `e2ad8df`.

### Session / publication lifecycle

- Build completed status **before** marking a solution queryable (a throw must not leave a half-published browseable solve).
- Stop before any completed iteration publishes **nothing**.
- Stop-and-keep / continue keep solution identity; join analysis workers on shutdown before destroying the session.

**Pointers:** ROADMAP M0/M4; Zig host job lifecycle; historical commits `8ab3503`, `27236ac`, `40e81d6`.

### Archive: Explorer HTTP single-threaded open/save (pre-#287)

The retired C++ explorer accept loop handled **one client at a time**. Open/save were overlay jobs (HTTP **202** + `/api/status` `file_op`). That HTTP surface is gone.

**Still true on Zig IPC Study:** Keep status polling across Open/Save; let `engineClient.open/save` wait until `running` clears. Treat `stopPolling` aborts as shutdown cancel, not unreachable. Never surface raw AbortError text in the status bar. Failed Open must leave the prior `solution_id` intact.

**Pointers:** `desktop/src/state/studyStore.ts` (`openSolution` / `saveSolution`), `desktop/src/domain/requestScope.ts`.

### Study analysis scheduling (EV / equity / runouts)

Explorer used to have a **single-slot** ValueWorker. Overlapping `/equity` + `/values` (and status polls that re-enqueued) cancelled each other → blinking footers, stuck “Calculating…”, lost overlays (#181–#190).

**Do:**

- Prefer `POST/GET …/nodes/{id}/analysis` (multi-metric) or **lookup-first** enqueue so status reads never replace sibling work.
- Client: serialize ValueWorker-bound jobs; `pollAnalysis` must await the full ready/failed lifecycle (do not release the queue on the first `202`).
- Cache pages by solution / node / `analysis_revision` (profile epoch); restore on navigate instead of recomputing.
- Settled permanent failures (e.g. work-limit) must not thrash auto-resubmit; transient/settled errors must not stick forever when the node/revision changed.

**Don't:** Fire equity and values in parallel against a single analysis worker. Don't clear a failed payload to `null` in a way that creates an infinite auto-retry loop.

**Pointers:** PRs #181, #182, #184, #188, #190; `docs/EXPLORER.md`.

### Local EV vs Global / root-centered

`/values` utilities are **root-centered chips**. Study defaults to **local decision EV**: Fold → 0 for the acting seat by adding `local_offset` (= `-U_i(fold-now)`).

- Decision and chance nodes must store `state.contrib` so `local_offset` includes chips already invested on prior streets — half the starting pot alone is wrong after bet/call (#184).
- **Fold column:** index Fold from `values.actions` (same order as `action_ev`), then `+ local_offset`. Indexing Fold from `node.actions` or using `row[foldIdx] ?? 0` turns a miss into baseline 0 and makes Local conversion a **silent no-op** (Settings say Local, UI still looks Global) (#182).
- Prefer the Settings store for `evDisplayBasis` over a stale study-store copy.
- Fixtures that only face a bet with actor `contrib = 0` can mask a zero-contrib bug (offset looks like “half pot” and tests still pass).

**Pointers:** PRs #182, #184; `desktop/src/domain/browse.ts`; `docs/EXPLORER.md`.

### Node lock vs line lock

Default lock scope is **`node`** (Pio `lock_node`): keep turn/river cards from `node_id` so locking one river does **not** silently lock every runout on that betting line (#201). Explicit `scope: "line"` stores `pN.t-1.r-1` (Pio `lock_line`). Engine lookup: exact runout first, then line fallback. PSOL: `lock N at T R …` vs `lock N line …`; legacy lines without `at`/`line` open as line locks.

At a flop root, `t-1.r-1` is both the node id and the line key — **do not infer scope from cards alone**; keep an explicit `LockScope` / `scope` field. A node lock must not overwrite a line lock for the same infoset.

**Don't:** Strip turn/river from lock keys “for infoset convenience.”

### Study equity path vs Equity Calculator

- **Historical C++:** Study node `/equity` used `StreetBatchSolver::checkdown_equity` (cached rank tables) — same check-down math, much faster than pair enumeration (#191).
- **Zig Study:** host `equity` must use **reach-weighted** `replayReachWeights` → `checkdownEquityAtNode` on the node board (#293). Returning starting-board / starting-range check-down at every node is a regression.
- **Equity Calculator** is a separate IPC job surface (`start_equity_job` / `get_equity_job` / `cancel_equity_job`) — multiway Auto/Exact/Monte Carlo — not Study node equity (#297).
- Work limits: never silently sample when over the pair-runout ceiling. Study packaging ceilings and calculator defaults differ; keep host constants aligned with what Tauri/Study expect.
- Warm the **current** decision (queue + identity-keyed cache). Do **not** full-tree frontload EV/equity into the save (#184, #190, #191).

User-facing Study copy says **Equity** (not “Check-down equity”); the quantity is still check-down pot fraction, not chip EV (#189).

Hands / Eq overlay: wire acting-seat equity (not an empty `Map`); look up via normalized `comboKey` (suit-order variants); gate ready/pending with solution+node id so navigate does not show another node’s Eq (#170). Node inspect must fill strategy-conditioned `reach` / `marginal` or the matrix treats every cell as undefined (#292).

### Frozen parallel + cold action EV

- Train/BR and cold average-value walks may steal **first future public card** tasks across workers; nested chance stays serial on the claiming worker (#177, #194).
- Wall-clock “parallel must beat serial” asserts are flaky on cold/shared CI VMs and under sanitizers — pin **numerical parity**; soften or skip timing gates (#201). Avoid `__has_feature` guards that break MSVC.

### Solve progress / Accuracy stop

- Progress: iteration counter every train step; EV / gap / Accuracy refresh about every 10 iters (or denser if Samples is raised) (#180). `time_limit: 0` stops after the first completed iteration.
- Early-stop uses **Pio Accuracy** (`NashConv / 2`). Compare the threshold to **Accuracy chips**, not raw NashConv (off-by-2 early/late stop). Default CLI/UI **unit** is pot fraction (`--accuracy 0.05` or `5 chips`); Pio UPI’s chips-default unit is not our product default (#179). Keep `nash_gap` as NashConv for reporting.
- **Acc-stop honesty (ZR-153):** `CompiledGame.pot` is **tenths**. Threshold chips = `accuracy_pot_fraction * tenthsToChips(pot)` — never multiply the fraction by raw tenths (10× threshold → false early “Accuracy reached”). After `train(1)`, publish cadence may leave a **stale** average; Study `trainGated` and gate-bench Acc checkpoints must `ensurePublishedExact()` so the evaluated average matches the reported iteration.

---

## 3. Codebase layout and conventions

### Config formats (easy to mix up)

| Kind | Format | Example |
| --- | --- | --- |
| Street CLI / PSOL canonical | `street-config 1` text, LF, trailing newline | `configs/street_default.txt` |
| River explorer default JSON | JSON field names (`effective_stack`, arrays) | `configs/river_default.json` |
| River canonical text | `river-config 1` | `include/game/river_config_text.hpp` |

Street text: omit empty size lists; chip sizes as `20c`; nonnegative = pot fraction.  
`--config` loads tree fields; **iterations / algorithm / accuracy / `--reference` / `--frozen` stay on the CLI** and override the file.

**Don't:** Invent JSON street configs or put iteration caps inside `street-config 1`.

### Study / street-config bet arrays

- **Absent** bet lists → defaults `{0.5, 1}` (same empty≠absent rule as historical explorer Job JSON).
- **Present empty array** → check-only.
- Raise lists are separate from bets: absent raises copy bets when multiples are also empty; present empty stays empty. The engine does not copy bets into an empty raise list. Study copies a blank raise box into that street's raise list before sending.
- A zero-length per-street list still falls back to the shared list. A one-element explicit-empty sentinel (`-`, stored as `-4e9`) does not. `e` / `2e` / `3e` / `a` / `Nx` stay sentinels until the decision node. Study Build blank bet = check-only; on import, empty street lists are resolved into shared sizes so rebuild keeps the same tree.
- `max_raises` counts facing raises only (opening street bets do not consume the cap). All-in is added only when that situation already lists a size, or the token `a` put one there. There is no `geometric` config/CLI/job flag — list `e` / `a` per street.
- **Build donk UI:** Turn/River donk size fields only — there is no Flop donk control (#195). AI context packs CI-reject stale “Flop donk” claims.

**Don't:** “Normalize” empty arrays back to defaults (historical note: [EXPLORER.md](../../EXPLORER.md)).

### Betting-tree files vs spot drafts

Build **Save tree / Open tree** uses client JSON `holdem-study-betting-tree` v1 (`desktop/src/domain/bettingTreeFile.ts`): sizes, caps, `tree_edits` only. It must **not** rewrite board, ranges, or stop criteria (#203).

### Create Build spot from Study

Eligible only at **street-start** turn/river OOP decisions (#193). Copy **raw** strategy-conditioned reaches (not posterior marginals), node pot, and effective remaining stack; reuse source sizing via `GET …/config`; clear path-scoped tree edits / incentives / ICM. When IP aggressed on the prior street, **bake donk sizes** into OOP’s starting-street bets (new trees have no prior aggressor). Verify root legal actions with `tree-preview`; open Build for review — do **not** auto-solve. Midstreet extraction (facing bet / street contrib) stays out of scope until `StreetConfig` carries initial betting state.

### Study UI paint order

Matrix, Hands, Node Locking, and the Actions mix bar paint **passive → aggressive** left-to-right through one shared path: `buildStrategyPaintSegments` + `StrategyPaintBars` (order from `orderActionIndicesByAggression`). Do **not** rebuild flex segment markup or reverse paint order in a feature component — that is how Hands and the matrix drifted apart. Frequency sliders and Action filter blocks stay in **engine action order** (index-bound) (#185). Hands metric lists may use `orderActionIndicesAggressiveFirst` (text only).

### AI context packs / Study assistant

- Packs under `docs/ai-context/{help,setup-assistant,unified}.md` are **generated**. Edit `docs/ai-context/source/`, then `cd desktop && npm run sync:ai-context`. CI `npm run check:ai-context` fails on drift or forbidden stale UI phrases (#196).
- Assistant entry is menu-bar **Assistant** (not Help → Study assistant). No Build-page Setup assistant. Workspaces include **Equity**.
- Bounded Study evidence tools (`query_node_strategy`, `list_bluff_candidates`, `query_selected_hand_analysis`) read the **current** Study decision only; they may peek ≤2 hops for a path hint and wait on the analysis scheduler, but must **not** start solves, open filesystem/HTTP beyond the engine client, or **navigate the Study tree**. Prefer honest absences over invented mixes (#197).
- Unified chat: help/how-to stays on `answer_user` + evidence tools; poker terms (3BP, 100NL) alone never force setup. Assemble `unified.md` once (no re-injecting help+setup wholes). Serialize evidence by trimming rows **before** JSON so tool results stay valid.
- `contextSnapshot` v2 carries published-solution identity, node path/seat/board, strategy, selected-hand analysis, and readiness — including equity + NashConv/Accuracy gaps. Published/node boards must **not** fall back to the Build draft board.
- Build Preview and Solve must share one `buildJob` serializer with host `tree_preview` (#192).

**Pointers:** `docs/ai-context/README.md`, `docs/STUDY_SETUP_ASSISTANT.md`.

### Archive: CMake and tests (pre-#287)

Historical C++ targets (`street_solver`, `river_solver`, `explorer`, `poker_*_tests`) and `ctest` are removed. **Current product testing:** `zig build test`, `scripts/zig/study-contract-smoke.py`, `cd desktop && npm test` / `npx tsc -b` — see [TESTING.md](TESTING.md).

### Platform gaps

- **Zig CI:** after engine/host changes run `zig build` + `zig build test` (`.github/workflows/zig.yml`). Prefer `-Dcpu=x86_64_v2` for portable Windows artifacts (#288/#289).
- **Desktop `tsc -b`:** Study store nullability fails `desktop` / installer CI when vitest is green (#190/#191). After lifecycle/IPC client changes, run `cd desktop && npx tsc -b`.
- **CI path gate:** `dorny/paths-filter` needs `pull-requests: read` under restricted `GITHUB_TOKEN` scopes; fail the aggregate `ci` job if the path gate itself fails (#200).
- **NSIS / installer hooks:** wait for **`windows-installer`** green before merge on spawn/NSIS changes (#158/#159/#161). Stable installer must ship `solver-engine.exe` only and fail if `holdem-explorer` reappears (#286).
- **Tauri sidecar spawn (Zig):** `externalBin` → `binaries/solver-engine`; installed file is `<exe_dir>/solver-engine.exe`. Spawn the absolute path beside the app. Packaged UI must **statically import** `@tauri-apps/api/core`. Own the child via IPC ready + launch id — not “any TCP on 8765.”
- **NSIS upgrade + sidecar lock:** PREINSTALL must kill the UI via `nsis_tauri_utils::KillProcessCurrentUser` (do **not** re-insert Tauri 2.5 `CheckIfAppIsRunning`), then `taskkill` / delete **both** `solver-engine.exe` and legacy `holdem-explorer.exe`. Never `taskkill` `explorer.exe` (Windows shell).
- **Packaged security:** production CSP (#242); assistant secrets in OS **keyring** (#243).
- **Historical C++ HTTP gaps** (pre-cutover trees only): Linux/Windows `poker_http_tests`, MSVC stack, `holdem-explorer` path quirks — do not restore those shipping paths on `main`.

### Licensing

Do not change `LICENSE`, SPDX, or license metadata. `UNLICENSED` ≠ Unlicense. See `.cursor/rules/licensing.mdc`.

### Branch / PR hygiene (cloud)

- Branches: `cursor/<descriptive-name>-<run-suffix>`, lowercase (suffix comes from the cloud-run instructions).
- Prefer the **product tip** as `base_branch` (`main`).
- Update `docs/auxiliary/planning/FEATURE_PARITY.md` **only** in the commit that demonstrates the row change.
- When UI chrome moves, update `docs/ai-context/source/` + `sync:ai-context` and player docs in the **same** change when packs claim those labels.

---

## 4. Poker / solver correctness traps

### NashConv vs Pio Accuracy

Here the printed Nash gap is **NashConv** = sum of both players’ unilateral BR gains (`(u0(BR0)-u0) + (u1(BR1)-u1)`). Under zero-sum chips that equals `u0(BR0) + u1(BR1)`. Pio **Accuracy** is the **average** of those gains (`NashConv / 2`).

**Do:** Accuracy stops use **Accuracy / pot** by default (optional `chips` unit). A study bar of ≤ 0.001 means Pio Accuracy/pot, not NashConv/pot.  
**Pointers:** `docs/auxiliary/planning/ROADMAP.md` §6, `docs/MATHEMATICS.md`, `docs/auxiliary/reference/HUNL.md`.

### Own-reach averaging and CF regret

- Average strategy accumulates with the **acting player’s** reach (× iteration weight for CFR+).
- Counterfactual regret uses **opponent × chance** reach.
- A hand can have a slot and receive CF values with **zero own strategic reach**.
- Structural support (off-board / no compatible opponent) ≠ tiny floating-point residual reach.

### Tiny compatible mass / blockers

When blocker subtraction cancels the live compatible mass, **sum compatible opponent mass directly** — do not invent a uniform opponent. If compatible mass `D_i(h) = 0`, action EV is **undefined** (null), not zero.

**Pointers:** commit `a803d22`, `docs/MATHEMATICS.md` (conditional action values), ROADMAP M1 gate.

### Chance

Next public cards are **pair-conditional** (remaining deck given both holes + board). At zero joint reach, chance card weights are null. Chance probabilities stay independent of thread count. Action EV is not defined on chance nodes (host rejects; historical explorer returned HTTP 400).

### Conditional action EV

Force the action **once**, then follow the **stored average** (not a best response). Root-centered chips; IP displayed with sign flip. Profile **epoch** must invalidate the value cache on training / reset / average edits — **not** when a reader merely rebuilds the average.

On historically flop/turn-only pages, river `/values` returned 400 until river EV work landed — check current branch before assuming river values exist.

**Don't:** Mutate regrets/strategy during a values query.  
**Pointers:** `docs/MATHEMATICS.md`, commits `1bb5b6d`, `a123c8e`, `27236ac`.

### Equity ≠ chip EV

Check-down equity is a **fraction of the pot** under check-down. Strategic EV is **root-centered chips**. Keep units and labels separate (`docs/EQUITY.md`, `StreetNodeEquity`).

Made-hand **categories** (when present) are category mass on a **five-card** board — not draws/backdoors unless explicitly implemented.

### Memory budget

`StreetConfig::memory_mib` (default 1024, zero rejected) bounds **engine-owned heap** charged before allocate. Not process RSS. `estimated_peak_bytes` is a plan; `peak_allocated_bytes` is measured. Stacks, RSS, exports, and some caches sit outside the budget.

**Pointers:** `docs/STREETS.md`, `StreetMemoryReport`, commits `56d6f38`, `3e9b9ef`.

### Hard limits agents rediscover the hard way

| Limit | Where | Agent mistake |
| --- | --- | --- |
| ≤ 8 legal actions at a decision | `kMaxStreetActions` / trainer scratch | Large size lists without merging |
| `StreetGame` ≤ ~200k terminals | reference enumerator | “Fix” big spots by raising the cap instead of using batch |
| Equity work limit ~1.1e6 pair-runouts | library / Equity Calculator default | Full-range turn rejected; don't silently sample |
| Study equity ceiling ~51.4e6 | packaged Study `--max-pair-runouts` | Dense flop check-down can still exceed; raise explicitly |
| Public tree depth / history caps | street index | Pathological trees |

### Labels and node ids

- Infosets: `OOP AhAd | <place> | <path>` (five-card street labels may omit place to match river — follow the branch you are on).
- Actions: `Check`, `Call`, `Bet N`, `Raise to N`, all-in variants via chip labels.
- Node ids: `p0.t-1.r-1` style; leading zeros OK; overflow/junk / wrong solution → host error reply (historical explorer used HTTP 400/404 — do not cite those as live coverage).
- Solution/job tokens: `sN` / `jN`, whole-token parse.

### Betting semantics (street)

Sizes are pot fractions unless negative / `Nc` chip form, or a Pio sentinel (`e`, `Ne`, `a`, `Nx`, `-`). Street-specific lists replace shared lists on that street. Empty raise list with non-empty raise-multiples does not fall back to bet sizes. Geometric = equal pot fractions over streets left at that node (river = all-in fraction). `2e` is two equal bets from the current pot and stack, not twice the root fraction — TS encoding must match the engine size rules; do not revive helpers that multiply the geometric fraction or a global geometric flag. Donk sizes only after IP aggression previous street; explicit-empty donk checks. `--no-three-bet` removes the re-raise. All-in threshold snaps large commitments to all-in when allowed. Blank list does not invent an all-in; list `a` explicitly.

**Pointers:** `docs/STREETS.md`, Zig `street_config` under `engine/`.

### Five-card / river join specifics

- `betting_streets = 6 - board_size`; `street_kind = street + (size - 3)` maps onto flop/turn/river size lists.
- Five-card rank cache: one key `reserve_key(-1, -1)`; no post-street chance.
- Matching `RiverGame` strategies requires **compatible infoset labels** (place segment policy).
- Defaults differ: e.g. `RiverConfig::max_raises` historically 2 vs `StreetConfig` default 1 — convert fixtures carefully when pinning.

---

## 5. Roadmap and “done” claims

Release A emphasis: M0→M5 plus **core M6**. Most `FEATURE_PARITY.md` rows are `partial` / `missing`; none are Pio-`verified`.

| Claim | Reality check |
| --- | --- |
| Conditional action EV “done” | M1 gate: profile epoch, tiny compatible mass, value-worker shutdown |
| M2 study screen “done” | Categories/draws/composition/undo still thin even if one slice lands |
| M5 saves “done” | PSOL exists; compact/lazy/multi-file library does not |
| M6 “done” | Zig Session five-card pins + study corpus; Pio timing/quality unproven |
| M8 rake/ICM | Pot-rake on Zig path; **ICM Study solves reject until ZR-93** (low priority) |
| “As fast as Pio” | Forbidden without matched protocol (`docs/auxiliary/planning/ROADMAP.md` §6); Acc walls ≠ cutover gates |

**Do:** Update ledger rows only with the demonstrating commit.  
**Don't:** Mark milestones complete from a single happy-path smoke (IPC contract or otherwise). Do not cite deleted C++ HTTP suites as coverage.

Cross-cutting invariants (ROADMAP §5): card removal, pair-conditional chance, zero-own-reach counterfactuals, own-reach averaging, pass-level updates, utility signs, immutable published analysis. Faster code that breaks these fails the project contract.

---

## 6. What worked (keep doing)

- Oracle / rematch pins on tiny fixtures before scaling (`zig build test`).
- Flush solver phase lines so interrupted study runs still show construction/cache/last eval.
- Explicit units in UI/API (`chips` / `root_centered` vs `fraction of the pot` / Equity).
- Parent-integrated parallel tracks with disjoint paths and immediate PR open after push.
- `zig build test` + `scripts/zig/study-contract-smoke.py` + desktop vitest/`tsc -b` locally before push; watch for unexpected SKIP / soft-gated IPC stubs.
- After Study client/analysis changes: desktop vitest **and** `npx tsc -b`; after assistant/UI label moves: `npm run check:ai-context`.
- Pin numerical rematch parity for EV/BR/Acc-stop; treat wall-clock scoreboard asserts as soft.
- Restack parallel Zig IPC slices onto tip carefully; keep `dispatch.zig` / `client.ts` append-friendly.

---

## 7. Keeping this doc fresh

- Durable scheduled refresh: Cursor Automation [Update docs](https://cursor.com/automations/138d322b-ddfd-11f1-ba91-f63b1661ac50) plus the paste-ready prompt in [`AGENT_LESSONS_REFRESH.md`](AGENT_LESSONS_REFRESH.md). Prefer the **product tip** base (`main`).
- When a PR fixes an agent-rediscovered trap, add a short **Do/Don't** here in the same PR when practical.
- Update the short digest in `.cursor/rules/parallel-agents.mdc` and root `AGENTS.md` whenever a new trap belongs in every agent’s always-on context.

---

## 8. Quick pointers

| Topic | Start here |
| --- | --- |
| Docs index | `docs/README.md` |
| Module map | `docs/ARCHITECTURE.md` |
| Street tree / budget / frozen | `docs/STREETS.md` |
| River chips / oracle | `docs/RIVER.md` |
| Math / EV / NashConv | `docs/MATHEMATICS.md` |
| Study UI / Zig IPC | `docs/DESKTOP_UI.md` (HTTP explorer notes are historical) |
| Equity | `docs/EQUITY.md` |
| Assistant / AI packs | `docs/STUDY_SETUP_ASSISTANT.md`, `docs/ai-context/README.md` |
| Zig release / cutover gates | `docs/auxiliary/engineering/ZIG_RELEASE_GATES.md` |
| Milestones / gates | `docs/auxiliary/planning/ROADMAP.md`, `docs/auxiliary/planning/FEATURE_PARITY.md` |
| Testing / benches | `docs/auxiliary/engineering/TESTING.md`, `benchmarks/study/README.md` |
| Lessons refresh automation | `docs/auxiliary/engineering/AGENT_LESSONS_REFRESH.md` |
