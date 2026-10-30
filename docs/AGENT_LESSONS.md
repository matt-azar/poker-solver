# Lessons for future agents

Mistakes, friction, and correctness traps observed in this repository’s history and in multi-agent cloud runs. Read before changing solvers, spawning sibling agents, or claiming a milestone is done.

Related always-on rule: `.cursor/rules/parallel-agents.mdc`. Licensing: `.cursor/rules/licensing.mdc`.

---

## 1. Parallel Cursor agents (operational friction)

### Hard rules

1. **One writer per tree.** Delegated Task / best-of-n runners may still write into shared `/workspace` even when told to use an isolated worktree. Do not `git checkout`, reset, or commit on `/workspace` while siblings run unless you have confirmed they never touch that path.
2. **Disjoint file ownership.** Assign path prefixes per agent. If two tracks need the same file (`CMakeLists.txt`, `explorer_main.cpp`, `FEATURE_PARITY.md`), serialize or let only the parent edit it.
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
Branch: cursor/<name>-c006 from <exact base ref>.
Push with git push -u origin <branch>.
Do not open a PR (parent will ManagePullRequest).
Do not change LICENSE.
Report: tip SHA, files touched, test command + counts, compare URL.
```

### Recovery checklist (interleaved tree)

1. Inventory with `git status` / `git diff --stat`.
2. Commit all dirty + untracked onto `cursor/wip-<topic>-c006`.
3. For each feature: branch from `origin/main` (or dependency base).
4. `git checkout wip -- <only that feature’s files>`.
5. Trim CMake, harness, `test_main`, and docs.
6. `CXX=g++` build; run `poker_solver_tests`; fix.
7. Push; parent opens PR; subscribe CI.
8. Keep WIP for archaeology until splits are pushed.

---

## 2. Architecture and module boundaries

### Two production postflop engines (until M6 finishes)

A flop, turn, and river are **one** betting tree with two, one, or zero cards left. The **current `main` tip** still splits by board length:

| Board | Production path | Reference enumerator |
| --- | --- | --- |
| 3 or 4 cards | `StreetBatchSolver` | `StreetGame` + `CfrTrainer` (`--reference`) |
| 5 cards | `RiverBatchSolver` | `RiverGame` + `CfrTrainer` (`--reference`) |

Open work (do not invent a third story): StreetBatch accepting five-card boards, then explorer routing five-card through StreetBatch, then retiring `river_solver` as a product entry only after pins match `RiverGame`.

**Do:** Keep `RiverGame` as the five-card oracle forever.  
**Don't:** Delete `river_solver` or switch explorer before five-card StreetBatch pins land.  
**Pointers:** `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` M6, `include/game/street_game.hpp` (on `main`: rejects non-3/4 boards).

### `*Game` vs `*Batch`

- `RiverGame` / `StreetGame` — full deal enumeration; oracle for strategy, values, best response.
- `RiverBatchSolver` / `StreetBatchSolver` — one public betting tree, same CFR/CFR+ update, production default.

**Do:** Pin batch changes against `--reference` / `CfrTrainer<*Game>` on small fixtures.  
**Don't:** “Optimize” by changing only the batch kernel without an oracle gate.

### Kuhn / Leduc stay on `CfrTrainer`

Public-tree frozen passes, engine heap budgets, and explorer sessions are street/river-specific.

**Don't:** Wire Kuhn/Leduc into `StreetBatchSolver`, frozen threads, or explorer solve jobs.

### `include/` must not depend on `ui/`

Engine and session types live under `include/game`, `include/solver`, `include/explorer`, `include/poker`. HTTP and static files are `src/explorer_main.cpp` + `ui/`.

**Don't:** `#include` anything from `ui/` in `include/`.

### Utility sign and player index

- River/street: **player 0 = OOP**, terminal utility is **P0 net chips** (root-centered); IP is the negation under chip zero-sum.
- Kuhn docs historically talk about player 1 first — do not paste that into street EV / NashConv code.

**Do:** Treat reported solver EV as OOP/`u0` unless a dual-payoff API says otherwise.  
**Pointers:** `docs/RIVER.md`, `docs/MATHEMATICS.md`, `include/solver/trainer.hpp`.

### Frozen pass, threads, CFR+ floor

- `--threads N>1` requires `--frozen`; per-deal walk stays serial.
- Parallelism splits the **first future public card** only (turn→rivers, flop→turns).
- Public frozen path: vanilla CFR and CFR+ (not Linear CFR).
- CFR+: sum counterfactual regret across the frozen pass, then **floor only the updating player**; leave the opponent table alone.

**Pointers:** `docs/STREETS.md` (frozen threads), `src/solver/street_batch.cpp` `train_frozen`, commits `9e0d87d`, `6a597df`, `e2ad8df`.

### Session / publication lifecycle

- Build completed status **before** marking a solution queryable (a throw must not leave a half-published browseable solve).
- Stop before any completed iteration publishes **nothing**.
- Stop-and-keep / continue keep solution identity; join the value worker on shutdown before destroying the session.

**Pointers:** commits `8ab3503`, `27236ac`, `40e81d6`, `docs/EXPLORER.md`, ROADMAP M0/M4.

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

**Don't:** “Normalize” empty arrays back to defaults (`docs/EXPLORER.md`).

### CMake and tests

- Prefer explicit targets (`street_solver`, `river_solver`, `explorer`, `poker_solver_tests`).
- Full bare `cmake --build` also builds long optional benches that are **not** CTest.
- MSVC tests need a larger stack (`/STACK:8388608` in CMake).
- On Linux cloud images, prefer `CXX=g++` if `clang++` lacks libstdc++.

### Platform gaps

- On **`main`**, `tests/unit/test_explorer_http.cpp` still **SKIPs on non-Windows**. A green Linux CTest alone is not HTTP coverage. (Linux HTTP port may live on a separate PR — check before claiming the gap is closed.)
- Some working-set / card-delay asserts are Windows-only (`#ifdef _WIN32`).
- Assertion totals differ by compiler; fail missing parity checkpoints instead of skipping (`cc12bc8`).

### Licensing

Do not change `LICENSE`, SPDX, or license metadata. `UNLICENSED` ≠ Unlicense. See `.cursor/rules/licensing.mdc`.

### Branch / PR hygiene (cloud)

- Branches: `cursor/<descriptive-name>-c006`, lowercase.
- Prefer `base_branch=main` unless stacking on an unmerged dependency; say so in the PR body.
- Update `FEATURE_PARITY.md` **only** in the commit that demonstrates the row change.

---

## 4. Poker / solver correctness traps

### NashConv vs Pio “exploitability”

Here the printed Nash gap is **NashConv** = sum of both players’ unilateral BR gains (`u0(BR0) + u1(BR1)`). Pio often reports the **average** of those gains.

**Do:** Convert before comparing to Pio (often divide by 2). Accuracy stops use **NashConv / pot** (study bar often ≤ 0.001 where declared).  
**Pointers:** `docs/ROADMAP.md` §6, `docs/MATHEMATICS.md`, `docs/HUNL.md`.

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
| Equity work limit ~1e6 pair-runouts | equity calculator | Full-range river rejected; don't silently sample |
| Public tree depth / history caps | street index | Pathological trees |

### Labels and HTTP ids

- Infosets: `OOP AhAd | <place> | <path>` (five-card street labels may omit place to match river — follow the branch you are on).
- Actions: `Check`, `Call`, `Bet N`, `Raise to N`, all-in variants via `chip_label`.
- Node ids: `p0.t-1.r-1` style; leading zeros OK; overflow/junk → 400; wrong solution → 404.
- Solution/job tokens: `sN` / `jN`, whole-token parse.

### Betting semantics (street)

Sizes are pot fractions unless negative / `Nc` chip form. Street-specific lists replace shared lists on that street. Empty raise list with non-empty raise-multiples does not fall back to bet sizes. Geometric = equal pot fractions over streets left (river = all-in fraction). Donk sizes only after IP aggression previous street. `--no-three-bet` removes the re-raise. All-in threshold snaps large commitments to all-in when allowed.

**Pointers:** `docs/STREETS.md`, `StreetConfig` comments in `street_game.hpp`.

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
| M6 “done” | Need five-card StreetBatch pins **and** production path join; then retire CLI |
| M8 rake/ICM | Needs dual-player payoff first; chip path is still player-0 scalar + negation |
| “As fast as Pio” | Forbidden without matched protocol (`docs/ROADMAP.md` §6) |

**Do:** Update ledger rows only with the demonstrating commit.  
**Don't:** Mark milestones complete from a single happy-path HTTP smoke.

Cross-cutting invariants (ROADMAP §5): card removal, pair-conditional chance, zero-own-reach counterfactuals, own-reach averaging, pass-level updates, utility signs, immutable published analysis. Faster code that breaks these fails the project contract.

---

## 6. What worked (keep doing)

- Oracle pins: batch vs `CfrTrainer<*Game>` on tiny fixtures before scaling.
- Flush solver phase lines so interrupted study runs still show construction/cache/last eval (`381c9a5`).
- Explicit units in UI/API (`chips` / `root_centered` vs `fraction of the pot` / `check-down`).
- Parent-integrated parallel tracks with disjoint paths and immediate PR open after push.
- Full `poker_solver_tests` locally before push; watch for unexpected SKIP lines.

---

## 7. Quick pointers

| Topic | Start here |
| --- | --- |
| Module map | `docs/ARCHITECTURE.md` |
| Milestones / gates | `docs/ROADMAP.md`, `docs/FEATURE_PARITY.md` |
| Street tree / budget / frozen | `docs/STREETS.md` |
| River chips / oracle | `docs/RIVER.md` |
| Math / EV / NashConv | `docs/MATHEMATICS.md` |
| Explorer HTTP / UI | `docs/EXPLORER.md`, `docs/TESTING.md` |
| Equity | `docs/EQUITY.md` |
| Study benches | `benchmarks/study/README.md` |
