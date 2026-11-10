# Lessons for future agents

Mistakes, friction, and correctness traps observed in this repository’s history and in multi-agent cloud runs. **Read this file at the start of every coding task** (not only when spawning siblings or touching solvers). Root `AGENTS.md` and `.cursor/rules/parallel-agents.mdc` point here; keep them in sync when the short digest changes.

Related always-on rule: `.cursor/rules/parallel-agents.mdc`. Licensing: `.cursor/rules/licensing.mdc`. Refresh playbook: [`AGENT_LESSONS_REFRESH.md`](AGENT_LESSONS_REFRESH.md).

---

## 1. Parallel Cursor agents (operational friction)

### Hard rules

1. **One writer per tree.** Delegated Task / best-of-n runners may still write into shared `/workspace` even when told to use an isolated worktree. Do not `git checkout`, reset, or commit on `/workspace` while siblings run unless you have confirmed they never touch that path.
2. **Disjoint file ownership.** Assign path prefixes per agent. If two tracks need the same file (`CMakeLists.txt`, `explorer_main.cpp`, `docs/auxiliary/planning/FEATURE_PARITY.md`), serialize or let only the parent edit it.
3. **Parent owns forge writes.** Subagents often lack `ManagePullRequest` and must not use `gh` to create/update PRs. After a sibling pushes, the parent opens/updates the PR and subscribes CI.
4. **Snapshot before splitting.** If the tree is interleaved, commit everything onto `cursor/wip-…-c006`, then path-checkout onto clean feature branches from the correct base.
5. **Re-check `git status` before every commit.** Restore unexpected paths with `git checkout HEAD -- <path>`.
6. **Scope CMake / harness edits.** A WIP snapshot’s `CMakeLists.txt` / `tests/unit/test_main.cpp` / `tests/harness.hpp` will list every agent’s sources. Trim to this branch only.

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
Do not edit CMakeLists.txt, tests/harness.hpp, or tests/unit/test_main.cpp
  unless listed; if you must, add only your targets.
Branch: cursor/<name>-<run-suffix> from <exact base ref>
  (use the suffix required by this cloud run, e.g. -ce85 / -c006).
Push with git push -u origin <branch>.
Do not open a PR (parent will ManagePullRequest).
Do not change LICENSE.
Report: tip SHA, files touched, test command + counts, compare URL.
```

### Recovery checklist (interleaved tree)

1. Inventory with `git status` / `git diff --stat`.
2. Commit all dirty + untracked onto `cursor/wip-<topic>-<run-suffix>`.
3. For each feature: branch from `origin/main` (or dependency base).
4. `git checkout wip -- <only that feature’s files>`.
5. Trim CMake, harness, `test_main`, and docs.
6. `CXX=g++` build; run `poker_solver_tests`; fix.
7. Push; parent opens PR; subscribe CI.
8. Keep WIP for archaeology until splits are pushed.

### Post-merge / branch hygiene

- **Follow-ups on a merged head never reach `main`.** If more work lands on a branch after its PR merged (#208), rebase onto `origin/main` as a **new** PR. Do not assume the old head is still mergeable.
- Closed/merged PR heads and orphan `cursor/*` branches are pruned daily (`.github/workflows/prune-stale-branches.yml`, #199). Finish and open the PR before assuming the remote branch will stay.

---

## 2. Architecture and module boundaries

### One production postflop engine (M6)

A flop, turn, and river are **one** betting tree with two, one, or zero cards left. Production paths share `StreetBatchSolver`:

| Board | Production path | Reference enumerator |
| --- | --- | --- |
| 3, 4, or 5 cards | `StreetBatchSolver` | `StreetGame` + `CfrTrainer` (`--reference`) |

`river_solver` is a thin CLI that maps river JSON/flags into five-card `StreetConfig` and solves on that path. `RiverGame` remains the five-card oracle forever; `RiverBatchSolver` remains for internal oracle and legacy fixtures only.

**Do:** Keep `RiverGame` as the five-card oracle forever. Keep five-card StreetBatch pins against `RiverGame`.  
**Don't:** Reintroduce `RiverBatchSolver` as the product `river_solver` path. Don't delete `RiverGame` or RiverBatch oracle tests.  
**Pointers:** `docs/ARCHITECTURE.md`, `docs/auxiliary/planning/ROADMAP.md` M6, `include/game/street_game.hpp`, `src/cli/river_main.cpp`.

### `*Game` vs `*Batch`

- `RiverGame` / `StreetGame` — full deal enumeration; oracle for strategy, values, best response.
- `StreetBatchSolver` — one public betting tree; production default for flop/turn/river.
- `RiverBatchSolver` — public-tree river helper for oracle/legacy fixtures only (not the product CLI path).

**Do:** Pin batch changes against `--reference` / `CfrTrainer<*Game>` on small fixtures.  
**Don't:** “Optimize” by changing only the batch kernel without an oracle gate.

### Kuhn / Leduc stay on `CfrTrainer`

Public-tree frozen passes, engine heap budgets, and explorer sessions are street/river-specific.

**Don't:** Wire Kuhn/Leduc into `StreetBatchSolver`, frozen threads, or explorer solve jobs.

### `include/` must not depend on UI trees

Engine and session types live under `include/game`, `include/solver`, `include/explorer`, `include/poker`. HTTP and static files are `src/cli/explorer_main.cpp` + `src/explorer/` (serves `desktop/dist` or `legacy/ui/`).

**Don't:** `#include` anything from `legacy/ui/` or `desktop/` in `include/`.

### Utility sign and player index

- River/street: **player 0 = OOP**, terminal utility is **P0 net chips** (root-centered); IP is the negation under chip zero-sum.
- Kuhn docs historically talk about player 1 first — do not paste that into street EV / NashConv code.

**Do:** Treat reported solver EV as OOP/`u0` unless a dual-payoff API says otherwise.  
**Pointers:** `docs/RIVER.md`, `docs/MATHEMATICS.md`, `include/solver/trainer.hpp`.

### Frozen pass, threads, CFR+ floor

- `--threads N>1` requires `--frozen`; per-deal walk stays serial.
- Parallelism splits the **first future public card** only (turn→rivers, flop→turns).
- Public frozen path: vanilla CFR, CFR+, fixed DCFR(1.5,0,2), and PCFR+ (not Linear CFR).
- CFR+: sum counterfactual regret across the frozen pass, then **floor only the updating player**; leave the opponent table alone.
- PCFR+: same alternating schedule and CFR+ floor / linear own-reach average; match on \(R+m\) with \(m=\) last instantaneous CF regret (cold-start zeros \(m\); PSOL v3 may restore \(m\), v1/v2 reload zeros \(m\)).
- DCFR: same alternating frozen passes; after each pass **discount** the updating player's full regret row (signed; no CFR+ floor) with `t^α/(t^α+1)` on positives and `t^β/(t^β+1)` on non-positives; average with `t^γ` own-reach (defaults α=1.5, β=0, γ=2). PSOL v3 stores the actual params used. Reject DCFR and PCFR+ on the non-frozen walk and on legacy `RiverBatchSolver`.

**Pointers:** `docs/STREETS.md` (frozen threads), `src/solver/postflop/algorithms/cfr_plus.hpp` (CFR+ schedule), `src/solver/postflop/schedules.cpp` (`train_frozen` dispatch), commits `9e0d87d`, `6a597df`, `e2ad8df`.

### Session / publication lifecycle

- Build completed status **before** marking a solution queryable (a throw must not leave a half-published browseable solve).
- Stop before any completed iteration publishes **nothing**.
- Stop-and-keep / continue keep solution identity; join the value worker on shutdown before destroying the session.

**Pointers:** commits `8ab3503`, `27236ac`, `40e81d6`, `docs/EXPLORER.md`, ROADMAP M0/M4.

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

- Study node `/equity` uses `StreetBatchSolver::checkdown_equity` (cached rank tables / blocker masses) — same check-down math, much faster than pair enumeration (#191).
- Equity Calculator / CLI stay on `showdown_equity` + `kDefaultMaxPairRunouts` (~1.1M).
- Packaged Study raises `--max-pair-runouts` to `kStudyExplorerMaxPairRunouts` (= full-range turn, ~51.4M). Dense flop check-downs can still exceed that. **Never silently sample** when over the limit.
- Study ceiling is a **packaging knob**: keep C++ `kStudyExplorerMaxPairRunouts` and Tauri `STUDY_EXPLORER_MAX_PAIR_RUNOUTS` aligned; raising only an env var does nothing for the packaged desktop spawn (#188).
- Warm the **current** decision (queue + identity-keyed cache). Do **not** full-tree frontload EV/equity into the save — commercial “always ready” is kernel speed + non-thrashing plumbing (#184, #190, #191).

User-facing Study copy says **Equity** (not “Check-down equity”); the quantity is still check-down pot fraction, not chip EV (#189).

Hands / Eq overlay: wire acting-seat equity (not an empty `Map`); look up via normalized `comboKey` (suit-order variants); gate ready/pending with solution+node id so navigate does not show another node’s Eq (#170).

### Frozen parallel + cold action EV

- Train/BR and cold average-value walks may steal **first future public card** tasks across workers; nested chance stays serial on the claiming worker (#177, #194).
- Wall-clock “parallel must beat serial” asserts are flaky on cold/shared CI VMs and under sanitizers — pin **numerical parity**; soften or skip timing gates (#201). Avoid `__has_feature` guards that break MSVC.

### Solve progress / Accuracy stop

- Progress: iteration counter every train step; EV / gap / Accuracy refresh about every 10 iters (or denser if Samples is raised) (#180). `time_limit: 0` stops after the first completed iteration.
- Early-stop uses **Pio Accuracy** (`NashConv / 2`). Compare the threshold to **Accuracy chips**, not raw NashConv (off-by-2 early/late stop). Default CLI/UI **unit** is pot fraction (`--accuracy 0.05` or `5 chips`); Pio UPI’s chips-default unit is not our product default (#179). Keep `nash_gap` as NashConv for reporting.

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

### Explorer JSON bet arrays

- **Absent** `oop_bets` / `ip_bets` → defaults `{0.5, 1}`.
- **Present empty array** → check-only.
- Raise lists are separate from bets: absent `oop_raises` / `ip_raises` copies bets when multiples are also empty; present empty stays empty. The engine does not copy bets into an empty C++ raise vector. Study copies a blank raise box into that street's raise list before sending.
- A zero-length per-street list still falls back to the shared list. A one-element explicit-empty sentinel (`-`, stored as `-4e9`) does not. `e` / `2e` / `3e` / `a` / `Nx` stay sentinels until the decision node. Study Build blank bet = check-only; on import, empty street lists are resolved into shared sizes so rebuild keeps the same tree.
- `max_raises` counts facing raises only (opening street bets do not consume the cap). All-in is added only when that situation already lists a size, or the token `a` put one there. There is no `geometric` config/CLI/job flag — list `e` / `a` per street.
- **Build donk UI:** Turn/River donk size fields only — there is no Flop donk control (#195). AI context packs CI-reject stale “Flop donk” claims.

**Don't:** “Normalize” empty arrays back to defaults (`docs/EXPLORER.md`).

### Betting-tree files vs spot drafts

Build **Save tree / Open tree** uses client JSON `holdem-study-betting-tree` v1 (`desktop/src/domain/bettingTreeFile.ts`): sizes, caps, `tree_edits` only. It must **not** rewrite board, ranges, or stop criteria (#203).

### Create Build spot from Study

Eligible only at **street-start** turn/river OOP decisions (#193). Copy **raw** strategy-conditioned reaches (not posterior marginals), node pot, and effective remaining stack; reuse source sizing via `GET …/config`; clear path-scoped tree edits / incentives / ICM. When IP aggressed on the prior street, **bake donk sizes** into OOP’s starting-street bets (new trees have no prior aggressor). Verify root legal actions with `tree-preview`; open Build for review — do **not** auto-solve. Midstreet extraction (facing bet / street contrib) stays out of scope until `StreetConfig` carries initial betting state.

### Study UI paint order

Matrix, Hands, and Node Locking strategy bars paint **passive → aggressive** left-to-right (`orderActionIndicesByAggression`). Frequency sliders and Action filter blocks stay in **engine action order** (index-bound) (#185).

### AI context packs / Study assistant

- Packs under `docs/ai-context/{help,setup-assistant,unified}.md` are **generated**. Edit `docs/ai-context/source/`, then `cd desktop && npm run sync:ai-context`. CI `npm run check:ai-context` fails on drift or forbidden stale UI phrases (#196).
- Assistant entry is menu-bar **Assistant** (not Help → Study assistant). No Build-page Setup assistant. Workspaces include **Equity**.
- Bounded Study evidence tools (`query_node_strategy`, `list_bluff_candidates`, `query_selected_hand_analysis`) read the **current** Study decision only; they may peek ≤2 hops for a path hint and wait on the analysis scheduler, but must **not** start solves, open filesystem/HTTP beyond the engine client, or **navigate the Study tree**. Prefer honest absences over invented mixes (#197).
- Unified chat: help/how-to stays on `answer_user` + evidence tools; poker terms (3BP, 100NL) alone never force setup. Assemble `unified.md` once (no re-injecting help+setup wholes). Serialize evidence by trimming rows **before** JSON so tool results stay valid.
- `contextSnapshot` v2 carries published-solution identity, node path/seat/board, strategy, selected-hand analysis, and readiness — including equity + NashConv/Accuracy gaps. Published/node boards must **not** fall back to the Build draft board.
- Build Preview and Solve must share one `buildJob` serializer with `/api/tree-preview` (#192).

**Pointers:** `docs/ai-context/README.md`, `docs/STUDY_SETUP_ASSISTANT.md`.

### CMake and tests

- Prefer explicit targets (`street_solver`, `river_solver`, `explorer`, `poker_solver_tests`).
- Full bare `cmake --build` also builds long optional benches that are **not** CTest.
- MSVC tests need a larger stack (`/STACK:8388608` in CMake).
- On Linux cloud images, prefer `CXX=g++` if `clang++` lacks libstdc++.

### Platform gaps

- On **`main`**, `tests/unit/test_explorer_http.cpp` still **SKIPs on non-Windows**. A green Linux CTest alone is not HTTP coverage. (Linux HTTP port may live on a separate PR — check before claiming the gap is closed.)
- Some working-set / card-delay asserts are Windows-only (`#ifdef _WIN32`).
- Assertion totals differ by compiler; fail missing parity checkpoints instead of skipping (`cc12bc8`).
- **Desktop `tsc -b`:** Study store nullability (`node` / `liveEquity` unnarrowed) fails `desktop` and `windows-installer` CI even when vitest is green (#190/#191). After lifecycle/analysis changes, run `cd desktop && npx tsc -b`.
- **CI path gate:** `dorny/paths-filter` needs `pull-requests: read` under restricted `GITHUB_TOKEN` scopes; fail the aggregate `ci` job if the path gate itself fails (#200).
- **NSIS / installer hooks:** wait for **`windows-installer`** green before merge. A green non-installer subset is not enough — #158/#159 landed broken PREINSTALL arity / duplicate `kill:` labels and needed follow-ups (#161).
- **Tauri sidecar spawn:** `bundle.externalBin` may be `binaries/holdem-explorer`, but the installed file is `<exe_dir>/holdem-explorer.exe`. `shell().sidecar("binaries/holdem-explorer")` looks under a non-existent `binaries/` folder (os error 3). Spawn the absolute path beside the app (or `sidecar("holdem-explorer")`). Packaged UI must also **statically import** `@tauri-apps/api/core` — `@vite-ignore` dynamic imports leave a bare specifier that fails at runtime.
- **NSIS upgrade + sidecar lock:** A running/orphaned `holdem-explorer.exe` keeps the file locked → "Error opening file for writing: …\holdem-explorer.exe" (Ignore leaves a stale engine). PREINSTALL must kill the UI via `nsis_tauri_utils::KillProcessCurrentUser` (do **not** re-insert Tauri 2.5 `CheckIfAppIsRunning` — its `kill:` labels collide with the template's insert), then `taskkill /F /T /IM holdem-explorer.exe`, Sleep, and `Delete` the old sidecar. Never `taskkill` `explorer.exe`.

### Licensing

Do not change `LICENSE`, SPDX, or license metadata. `UNLICENSED` ≠ Unlicense. See `.cursor/rules/licensing.mdc`.

### Branch / PR hygiene (cloud)

- Branches: `cursor/<descriptive-name>-<run-suffix>`, lowercase (suffix comes from the cloud-run instructions).
- Prefer `base_branch=main` unless stacking on an unmerged dependency; say so in the PR body.
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

Next public cards are **pair-conditional** (remaining deck given both holes + board). At zero joint reach, chance card weights are null. Chance probabilities stay independent of thread count. Action EV is not defined on chance nodes (HTTP 400).

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

### Labels and HTTP ids

- Infosets: `OOP AhAd | <place> | <path>` (five-card street labels may omit place to match river — follow the branch you are on).
- Actions: `Check`, `Call`, `Bet N`, `Raise to N`, all-in variants via `chip_label`.
- Node ids: `p0.t-1.r-1` style; leading zeros OK; overflow/junk → 400; wrong solution → 404.
- Solution/job tokens: `sN` / `jN`, whole-token parse.

### Betting semantics (street)

Sizes are pot fractions unless negative / `Nc` chip form, or a Pio sentinel (`e`, `Ne`, `a`, `Nx`, `-`). Street-specific lists replace shared lists on that street. Empty raise list with non-empty raise-multiples does not fall back to bet sizes. Geometric = equal pot fractions over streets left at that node (river = all-in fraction). `2e` is two equal bets from the current pot and stack, not twice the root fraction — TS encoding matches `size_spec.hpp`; do not revive helpers that multiply the geometric fraction or a global geometric flag. Donk sizes only after IP aggression previous street; explicit-empty donk checks. `--no-three-bet` removes the re-raise. All-in threshold snaps large commitments to all-in when allowed. Blank list does not invent an all-in; list `a` explicitly.

**Pointers:** `docs/STREETS.md`, `StreetConfig` comments in `street_config.hpp`.

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
| M6 “done” | Five-card StreetBatch pins against `RiverGame` **and** `river_solver` on StreetBatch (not RiverBatch product path) |
| M8 rake/ICM | Needs dual-player payoff first; chip path is still player-0 scalar + negation |
| “As fast as Pio” | Forbidden without matched protocol (`docs/auxiliary/planning/ROADMAP.md` §6) |

**Do:** Update ledger rows only with the demonstrating commit.  
**Don't:** Mark milestones complete from a single happy-path HTTP smoke.

Cross-cutting invariants (ROADMAP §5): card removal, pair-conditional chance, zero-own-reach counterfactuals, own-reach averaging, pass-level updates, utility signs, immutable published analysis. Faster code that breaks these fails the project contract.

---

## 6. What worked (keep doing)

- Oracle pins: batch vs `CfrTrainer<*Game>` on tiny fixtures before scaling.
- Flush solver phase lines so interrupted study runs still show construction/cache/last eval (`381c9a5`).
- Explicit units in UI/API (`chips` / `root_centered` vs `fraction of the pot` / Equity).
- Parent-integrated parallel tracks with disjoint paths and immediate PR open after push.
- Full `poker_solver_tests` locally before push; watch for unexpected SKIP lines.
- After Study client/analysis changes: desktop vitest **and** `npx tsc -b`; after assistant/UI label moves: `npm run check:ai-context`.
- Pin numerical parity for parallel EV/BR; treat wall-clock speed asserts as soft.

---

## 7. Keeping this doc fresh

- Durable scheduled refresh: Cursor Automation prompt in [`AGENT_LESSONS_REFRESH.md`](AGENT_LESSONS_REFRESH.md) (create/activate at [cursor.com/automations](https://cursor.com/automations) against `matt-azar/poker-solver`).
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
| Explorer HTTP / Study UI | `docs/EXPLORER.md`, `docs/DESKTOP_UI.md` |
| Equity | `docs/EQUITY.md` |
| Assistant / AI packs | `docs/STUDY_SETUP_ASSISTANT.md`, `docs/ai-context/README.md` |
| Milestones / gates | `docs/auxiliary/planning/ROADMAP.md`, `docs/auxiliary/planning/FEATURE_PARITY.md` |
| Testing / benches | `docs/auxiliary/engineering/TESTING.md`, `benchmarks/study/README.md` |
| Lessons refresh automation | `docs/auxiliary/engineering/AGENT_LESSONS_REFRESH.md` |
