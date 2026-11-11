# Project history and design decisions

Narrative history of **poker-solver** / **Holdem Study**: why the codebase looks the way it does, which forks were taken, and which alternatives were deliberately rejected. Living how-to docs stay under [`docs/`](../../README.md). Ordered work and parity status live in [`ROADMAP.md`](../planning/ROADMAP.md) and [`FEATURE_PARITY.md`](../planning/FEATURE_PARITY.md). Agent traps distilled from this history: [`AGENT_LESSONS.md`](../engineering/AGENT_LESSONS.md).

This note covers roughly **2026-10-26 → 2026-11-11** (America/New_York), from the first Kuhn commit through Holdem Study **v0.1.2-windows**. It is archaeology and rationale, not a substitute for current architecture docs.

---

## 1. What this project is

A heads-up no-limit Texas Hold’em **GTO postflop study tool**: configure a finite bet-size tree, solve it with CFR-family algorithms, browse strategies and EV/equity, lock scenarios, save/resume, and ship that workflow as a Windows Study app.

**Product surface today:** `explorer` (local HTTP engine) + React Study UI (`desktop/`), packaged as **Holdem Study** via Tauri 2 + NSIS. CLI solvers (`street_solver`, thin `river_solver`, `equity_calculator`) remain first-class for benches and scripting.

**Comparison target:** documented PioSolver / PioViewer behavior (pinned around 3.11 in the roadmap). The project copies *workflow and tree-shape conventions*, not Pio’s proprietary solver or file formats. No public license is granted (`LICENSE`); a public license was deliberately reserved on 2026-10-28 and has not been selected.

**Authors:** Matt Azar (product owner) with heavy Cursor Agent co-authorship on implementation PRs.

---

## 2. Timeline at a glance

| When (America/New_York) | Era | Outcome |
| --- | --- | --- |
| 2026-10-26 | Kernel phases 1–6 in one day | Kuhn → shared CFR → Leduc → Hold’em cards → river → turn/flop trees |
| 2026-10-26–27 | Public-tree performance | `StreetBatch` frozen passes, heap budgets, first-card parallelism, river explorer |
| 2026-10-28–29 | Roadmap pivot | Phases 1–10 declared complete; Release A / M0–M13 Pio-like plan adopted |
| 2026-10-30–31 | Study baseline flood | Five-card on shared tree, EV/equity/locks/rake seeds, React Study client + Tauri shell |
| 2026-11-01–04 | Unify + reorganize | `river_solver` → StreetBatch; repo layout; CFR+ ownership split; NashConv fix |
| 2026-11-05–11 | Study polish + releases | Equity calculator, Bluffs, Node Locking UX, analysis lifecycle, v0.1.0→0.1.2 Windows |

Rough commit volume: ~392 commits on `main` in about two weeks (≈187 in October, ≈205 in early November 2026).

---

## 3. Era 0 — Intent and constraints (pre-code decisions)

Before the first commit, several constraints were already fixed and still hold:

1. **Exact unbucketed combos on commodity hardware.** One information set per two-card hand; no hand bucketing in the production path. Abstraction error would be exploitability in the unbucketed game, which this repo cannot fully measure for multi-street HUNL.
2. **Finite action abstraction.** Equilibria are of the *configured* bet-size tree (pot fractions, geometric `e`, all-in threshold, caps) — the same public-tree shape Pio-style postflop solvers use — not of unrestricted chip amounts at every decision.
3. **C++20, no third-party solver libraries.** CMake + standard library only for the engine. Deterministic: no RNG in the solvers.
4. **Reference games first.** Kuhn and Leduc exist to verify the shared trainer before Hold’em scale hides bugs.
5. **Oracle vs production.** Small full enumerators (`*Game` + `CfrTrainer`) stay available forever; production uses a public-tree batch kernel that must pin against those oracles on fixtures.

Unrestricted full HUNL (any raise size, full unbucketed preflop→river) was acknowledged as out of scope for commodity RAM. That limit was written down as phase 10 / [`HUNL.md`](../reference/HUNL.md).

---

## 4. Era 1 — Kernel phases 1–10 (2026-10-26 → ~10-27)

The original roadmap was a linear ten-phase kernel plan. It completed in essentially two calendar days.

### Phase sequence (as executed)

| Phase | Landed as | Design choice |
| --- | --- | --- |
| 1. Repo / CMake / tests | First commit scaffolding | Single CMake project, CTest, docs from day one |
| 2. Kuhn + vanilla CFR | `d2afa00` | Prove \(u \to -1/18\), Nash gap → 0, reproducible averages |
| 3. Generalized engine + CFR+ | `18f2f48` | One `CfrTrainer` for vanilla and CFR+; game behind an extensive-game interface |
| 4. Leduc | `57b9a6f` | Six-card chance game on the same trainer |
| 5. Hold’em cards / eval / ranges | `6d8b8cc` | 52-card ids, seven-card evaluator, 1,326 unordered hands, weighted ranges |
| 6. Heads-up river | `4cb99cc`, `31a5b3c` | First real Hold’em subtree: joint hand chance, OOP first, root-centered chip EV |
| 7. Performance | Public-tree river + later street work | Batch over deals on one public tree instead of expanding every history in the enumerator |
| 8. Turn / flop | `9ea3036`, `e064420`, `d2f50aa` | Same betting lines on every runout; later cards as chance nodes |
| 9. Explorer | `904c06e`, then flop paint `c408f30` | Local browser UI over an HTTP session — not a cloud product |
| 10. HUNL research | `bec0ba4` | Document the memory wall; measure linear CFR on Kuhn; no pretence of unrestricted HUNL |

### Design decisions locked in this era

**Extensive-game interface.** Games expose `root` / chance / terminal / infoset / actions. Anything that can implement that interface can train through `CfrTrainer`. Hold’em production later left that path for scale, but kept it as `--reference`.

**Player 0 = OOP; utilities = P0 net chips.** Root-centered chip EV: dead money is `pot/2` each, street investments add on top. Under zero-sum chips, IP is the negation. Kuhn documentation historically numbered players differently; street code must not import that numbering.

**Public betting tree.** Turn and flop store betting structure once and reuse it on every card (`e064420`). A player cannot have different size lists on different rivers. That matches Pio-style postflop trees and enables the batch kernel.

**Frozen combo pass (`d91fb5a`).** One public-tree traversal updates every hand: freeze regret matching, walk with a vector of hands, sum counterfactual regret, then (for CFR+) floor only the updating player (`6a597df`, `9e0d87d`). Opponent table stays untouched. This is the usual CFR+ alternating schedule with the floor after the infoset sum.

**Engine-owned heap budget (`56d6f38`, `3e9b9ef`).** Full-range check-downs must fail cleanly when they cannot fit. The budget charges bytes the engine requests *before* allocation; RSS and native stacks stay outside. Default 1024 MiB.

**First-future-card parallelism (`e2ad8df`).** Threads (default 1) split only the first remaining public card. Nested chance stays on the claiming worker. `N>1` requires `--frozen`. Evaluation stays on the caller.

**River explorer before a rich GUI.** The first UI (`904c06e`) was a single local page that could solve and inspect. That established the process boundary: engine owns numbers; UI is a client.

---

## 5. Era 2 — Roadmap pivot to Pio-like Study (2026-10-28 → 10-29)

Commit `7782967` replaced “finish phases 1–10” with a **three-release** product plan:

| Release | Intent |
| --- | --- |
| **A** | Dependable postflop study tool (build, solve, EV/equity, save/reopen) |
| **B** | Complete postflop workstation (locks, reports, queue, trainer, rake/ICM, polish) |
| **C** | Frozen-reference coverage including preflop / Edge-style gaps |

Milestones **M0–M13** ordered the work. Phases 1–10 were archived as complete in the roadmap appendix. A modern GUI became an explicit release requirement (`95242db`), not an afterthought.

### Design decisions in this pivot

**Parity ledger, not vibes.** [`FEATURE_PARITY.md`](../planning/FEATURE_PARITY.md) tracks families against documented Pio behavior with states `unverified` / `missing` / `partial` / `verified`. Rows update only with evidence commits.

**License reserved (`f923a02`).** CI and the ledger landed under an all-rights-reserved notice. No MIT/Unlicense substitution; agents are forbidden from changing `LICENSE` without explicit approval.

**Publication atomicity (M0, `8ab3503`).** Completed status is built *before* a solve becomes queryable. A throw must not leave a half-published browsable result. Stop before any completed iteration publishes nothing.

**Conditional action EV (M1).** Force one legal action, then follow the stored average. Root-centered chips; normalize by compatible opponent reach; tiny compatible mass uses a direct sum when blocker subtraction cancels (`a803d22`). Values are a separate query — status/navigation stay cheap.

**Check-down equity ≠ chip EV (`4c8b2f7`).** Equity is pot-fraction showdown under check-down. Study later renamed the UI label to plain “Equity” while keeping the math (`#189`).

**PSOL + continue (`3b5df1b`).** Versioned native save of config + regrets + strategy sums so stop-and-keep / reopen / continue share one algorithm state. Not a Pio file format.

**Five-card joins the shared tree in M6 (`36cb513`).** Explicit early decision: do *not* keep a permanent second production river kernel. `RiverGame` remains the five-card oracle forever.

---

## 6. Era 3 — Study baseline integration (2026-10-30 → ~11-01)

A large parallel-agent push landed overlapping stacks: five-card StreetBatch, dual payoffs, rake, pause/continue, node locks, templates, equity buckets, strategy reports. Merge order for the river-overlapping set was recorded in [`RIVER_INTEGRATION.md`](RIVER_INTEGRATION.md). Everyday capability after that merge: [`STUDY_BASELINE.md`](../planning/STUDY_BASELINE.md).

### Architecture decisions

**One production postflop engine.** Flop / turn / river differ only by cards left (2 / 1 / 0). Explorer five-card boards route through `StreetBatchSolver` (`899989d`). Later, `river_solver` itself became a thin CLI onto that path (`9d74b4d`, #65). `RiverBatchSolver` survived only for oracle fixtures and older river-kind PSOL.

**Dual-player payoffs (`37ddea9`).** `PlayerPayoff` / `ChipPayoff` return both seats’ utilities so rake, ICM, and incentives can be general-sum without rewriting terminals twice. Zero-rake chip mode stays bit-identical to prior `p1_utility`.

**Immutable node locks (M7 foundation).** Locks are a constraint layer keyed by public node and runout cards; applied after regret matching. Strategy *editing* was kept separate from *locking* (Pio distinction), and free-form edits later stayed session-scoped (not in early PSOL).

**Solve control: stop-and-keep, pause, continue, wall clock, eval cadence.** Useful work survives; construction cancellation still publishes nothing. Accuracy history only when a threshold is armed.

**Street-config 1 as canonical text.** Round-tripable LF documents rebuild the same tree. Iterations / algorithm / accuracy / `--reference` / `--frozen` stay on the CLI so configs describe *games*, not *runs*.

### Process decisions

**Parallel Cursor agents.** Many milestones were implemented concurrently. That produced interleaved trees, polluted shared workspaces, and wrong-docs-on-wrong-PRs. Recovery rules and path-ownership discipline were written into [`AGENT_LESSONS.md`](../engineering/AGENT_LESSONS.md) and the always-on `.cursor/rules/parallel-agents.mdc`.

---

## 7. Era 4 — Desktop Study product (2026-10-31 → 11-01)

The legacy explorer static page was not abandoned immediately; it became the regression fallback under `legacy/ui/`.

| Decision | Choice | Rejected / deferred |
| --- | --- | --- |
| Study client | React 19 + TypeScript + Vite + Zustand (`6b1c853`, #60) | Rewriting the engine in TS; Electron |
| Desktop shell | Tauri 2 + `holdem-explorer` sidecar (`1a0090d`, #61) | Shipping UI without a bundled engine |
| Engine boundary | Typed `EngineClient` over localhost HTTP | Embedding the solver in-process in the UI |
| Installer | Unsigned Windows NSIS via GitHub Actions | Code-signing (still open); macOS/Linux packages |
| Static serve | Prefer `desktop/dist`, else `legacy/ui/` | Deleting the legacy page |

**Sidecar spawn lesson.** Packaged apps must spawn `holdem-explorer` beside the exe, not under a non-existent `binaries/` folder from `externalBin` naming. NSIS PREINSTALL must kill the sidecar before overwrite (`#158`–`#161`).

**README product focus (`c6b2585`, #72).** Docs and README shifted from Kuhn/Leduc demos to Study as the entry point; reference games moved to auxiliary docs.

---

## 8. Era 5 — Engine deepening and cleanup (2026-11-01 → 11-04)

### Algorithms beyond default CFR+

- **DCFR(1.5, 0, 2)** optional on frozen public tree (`#57`); parameters later exposed (`#121`); PSOL v3 can store them.
- **PCFR+** (predictive RM+) on `CfrTrainer` and frozen StreetBatch (`#120`).
- Linear CFR remains available on the reference trainer path; public frozen path focuses on vanilla / CFR+ / DCFR / PCFR+.
- **Geometric flag removed (`#144`).** List `e` / `2e` / `3e` / `a` per size field — no separate config switch. Blank lists stay check-only; all-in is not injected into empty lists.

### Storage and evaluation

- **Float tables + shared sigma workspace (`#126`).** Persistent StreetBatch storage dropped from four `double` roles (32 B/entry) to regret + strategy-sum + shared sigma (`float`, 12 B/entry). Sensitive reductions stay double.
- **Compact infoset indexing (`#134`).** Legal-runout `slot_of`, packed slots, elided one-action rows.
- **NashConv correctness (`#133`).** Production had been summing absolute BR utilities. That equals NashConv only under zero-sum chips. Shared `EvaluationResult` uses unilateral gains; required for rake/incentives.
- **Accuracy stopping (`#179`).** Early-stop uses **Pio Accuracy = NashConv/2**, pot fraction by default. Reported `nash_gap` remains NashConv.

### Code ownership reorgs (behavior-preserving)

- **Repo layout (`#132`).** CLIs → `src/cli/`; explorer HTTP modules → `src/explorer/`; legacy UI → `legacy/ui/`; benches → `benchmarks/`.
- **CFR+ ownership (`#145`).** Production `poker_solver` holds StreetBatch + regret matching; Kuhn wrappers and RiverBatch behind CMake options; private `Engine` split under `src/solver/postflop/` with one readable CFR+ schedule header.

### M2 / M3 / M7 / M8 product slices

- Draws/backdoors, equity composition, nested ranges (`#68`).
- Visual tree line editor + `plan-memory` dry-run (`#67`).
- Free-form strategy edit drawer distinct from locks (`#66`).
- CategoryTag incentives, dual-utility BR, explorer JSON (`#69`).

---

## 9. Era 6 — Study UX and analysis correctness (2026-11-05 → 11-11)

This period was mostly desktop + analysis plumbing. Numerical semantics were tightened as UI density increased.

### Analysis lifecycle

Explorer historically had a **single-slot** value worker. Parallel `/equity` + `/values` plus status re-enqueue cancelled each other (blinking footers, stuck “Calculating…”). Fixes (`#181`–`#190`): serialize client jobs, await full ready/failed lifecycle, cache by solution/node/`analysis_revision`, prefer multi-metric analysis endpoints, never full-tree-frontload analysis into saves.

### Local vs global EV

`/values` stay root-centered. Study defaults to **local decision EV** (Fold = 0) via `local_offset`. Offset must include street `contrib`, not half pot alone (`#184`). Fold index comes from `values.actions`, not `node.actions` (`#182`).

### Equity paths

- Study node equity uses solver **rank tables** (`#191`) — same check-down math, far faster than pair enumeration.
- Standalone Equity Calculator / CLI keep the pair enumerator and work ceiling.
- Packaged Study raises `--max-pair-runouts` via aligned C++ and Tauri constants; never silently sample when over limit.

### Node vs line locks (`#201`)

Default lock scope is **this board** (keep turn/river from `node_id`). Explicit `scope:"line"` locks every runout. Flop root cannot infer scope from cards alone (`t-1.r-1` is both node and line).

### Study surface growth

| Feature | Notes |
| --- | --- |
| Equity Calculator workspace | Equilab-style, independent of a solution (`#156`) |
| Node Locking workspace | Dedicated Pio-style paint grid (`#171`) |
| Value / Bluffs tab | Mode A prominent bluffs; after-call equity via Call child (`#172`+) |
| Build tree catalogue | In-app save/open for betting trees only — not board/ranges (`#203`, `#221`) |
| Create Build spot from Study | Street-start turn/river OOP only (`#193`) |
| Compare runouts | Same betting line across cards; desktop orchestration |
| Study assistant | Unified help + setup + bounded evidence tools; generated AI context packs (`#196`, `#197`, `#216`) |
| Strategy paint | One shared passive→aggressive paint path for matrix and Hands (`#222`) |

### Docs reorganization (`#162`)

Primary docs = CFR+ workflow + Study UI. Planning, engineering, payoffs, reference games, and archive notes moved under `docs/auxiliary/`.

### Windows releases

| Tag | Approx. date | Role |
| --- | --- | --- |
| `v0.1.0-windows` | early Nov 2026 | First public unsigned NSIS cut |
| `v0.1.1-windows` | 2026-11-10 | Hygiene / installer / Study fixes |
| `v0.1.2-windows` | 2026-11-11 | Current cut at time of this history |

Code signing and upgrade/migration packaging remain open (M13).

---

## 10. Cross-cutting design decision catalog

Decisions that show up repeatedly in code review and agent mistakes. Prefer this table when asking “why is it like this?”

### Solver and math

| Decision | Choice | Why |
| --- | --- | --- |
| Production kernel | One `StreetBatchSolver` for 3/4/5-card boards | Avoid dual maintenance; flop/turn/river are the same tree shape |
| Five-card oracle | Keep `RiverGame` (+ RiverBatch fixtures) | Independent enumerator pins forever |
| Default algorithm | CFR+ with frozen pass | Standard strong default; DCFR/PCFR+ opt-in |
| Averaging | Own-reach weighted; CFR+ also × iteration | Textbook CFR+/CFR; do not average with opponent reach |
| CF regret weight | Opponent × chance | Not own reach |
| Unsupported vs zero reach | Structurally blocked hands have no infoset; supported zero-reach still gets CF values | Matches theory; avoids dropping counterfactuals |
| Tiny compatible mass | Direct sum when subtraction cancels | Blocker arithmetic can erase a live hand in float |
| Nash gap report | NashConv = sum of BR gains | Clear zero-sum identity; works with `EvaluationResult` under general-sum |
| Stop criterion | Pio Accuracy = NashConv/2 | Match Pio UPI “exploitability” naming; pot fraction default unit |
| Hand abstraction | None in production | Exact combos; bucketing would change the game |
| Chance sampling | None (full enumeration of configured tree) | Determinism; MCCFR not in-repo |
| Threads | Split first future public card only | Disjoint infoset writes; simple join semantics |
| Memory | Engine allocator budget, fail closed | Full-range trees must not OOM the machine silently |
| Table precision | `float` storage, `double` reductions | Memory vs numeric sensitivity trade |
| Action cap | 8 actions / infoset (scratch) | Explicit widen when needed |
| Kuhn/Leduc | `CfrTrainer` only | Do not wire toy games into StreetBatch / explorer jobs |

### Config and API

| Decision | Choice | Why |
| --- | --- | --- |
| Street config format | `street-config 1` text | Human-readable round-trip; not JSON |
| Empty bet arrays in explorer JSON | Present empty = check-only; absent = defaults | Pio-like “blank means no bet” without losing defaults |
| Raise lists | Separate from bets; engine does not copy bets into empty raises | Prevent accidental 3-bet trees |
| Geometric | Tokens in size lists, not a flag | One encoding path |
| Tree edits | Force / Remove / AddSize on public paths | Visual Build without forking config schema |
| Betting-tree files | Sizes/caps/edits only | Spot identity (board/ranges/stop) stays separate |
| `include/` vs UI | No includes from `desktop/` or `legacy/ui/` | Engine stays headless-testable |

### Study product

| Decision | Choice | Why |
| --- | --- | --- |
| Process split | `explorer` HTTP + UI clients | Same API for legacy page, React, Tauri, tests |
| Analysis | On-demand + warm current node | “Always ready” via kernel speed, not save bloat |
| EV display default | Local (Fold = 0) | Matches how players think at a decision |
| Equity label | “Equity” in UI; check-down math | Shorter copy; docs keep the distinction |
| Lock default scope | Node (this board) | Avoid silently locking every runout |
| Strategy edit vs lock | Separate APIs / UI | Pio mental model; edits not in early PSOL |
| Assistant | Client-side tools + context packs; no autonomous solve | Bounded evidence; human confirms setups |
| AI packs | Generated from `docs/ai-context/source/` | CI catches stale UI phrases |
| Installer | Unsigned NSIS current-user | Ship Study without requiring CMake on user machines |

### Engineering process

| Decision | Choice | Why |
| --- | --- | --- |
| Parallel agents | Disjoint paths; parent owns PRs | Shared `/workspace` pollution was real |
| FEATURE_PARITY updates | Only with demonstrating commit | Ledger stays evidence-backed |
| LICENSE | Do not change without Matt’s approval | Reserved public-license decision |
| Oracle gates on kernel changes | Pin against `CfrTrainer<*Game>` / RiverGame | Batch-only “optimizations” regress silently |
| Desktop after analysis/UI moves | `npx tsc -b` + vitest; `check:ai-context` when labels move | CI catches nullability and pack drift |
| Branch prune | Daily workflow on closed PR heads (`#199`) | Cursor branches do not live forever |

---

## 11. What was intentionally not built (yet)

These are deferred by roadmap order or explicit scope decisions — not accidental omissions:

- **Compact / lazy PSOL and omitted-street reconstruction** (M10)
- **Durable batch queue and board-set aggregation reports** (M9)
- **Trainer packs, drills, session stats** (M11) — `hand-history 1` schema only
- **Preflop / Edge-style trees** (M12) — after demonstrated postflop scale
- **Code-signed installers, saved layouts, localization** (M13)
- **Hand bucketing, MCCFR, suit isomorphism as default** — research options, not silent modes
- **Pio file compatibility / commercial hosting** — only after an explicit scope decision
- **Claimed Pio speed or solution-quality parity** — corpus and matched runs still required

---

## 12. How to read the rest of the docs after this

| If you need… | Go to… |
| --- | --- |
| Current module map | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| How a street solve runs | [`STREETS.md`](../../STREETS.md), [`MATHEMATICS.md`](../../MATHEMATICS.md) |
| Study UI / packaging | [`DESKTOP_UI.md`](../../DESKTOP_UI.md), [`EXPLORER.md`](../../EXPLORER.md) |
| Ordered remaining work | [`ROADMAP.md`](../planning/ROADMAP.md) |
| Leaf feature status | [`FEATURE_PARITY.md`](../planning/FEATURE_PARITY.md) |
| Post-integration snapshot | [`STUDY_BASELINE.md`](../planning/STUDY_BASELINE.md) |
| River unify archaeology | [`RIVER_INTEGRATION.md`](RIVER_INTEGRATION.md) |
| HUNL memory wall | [`HUNL.md`](../reference/HUNL.md) |
| Agent don’t-repeat list | [`AGENT_LESSONS.md`](../engineering/AGENT_LESSONS.md) |

---

## 13. Maintenance

Update this history when a decision **reverses** a choice above (for example: RiverBatch returns as a product path, bucketing becomes default, or a public license is selected), or when a new major era begins (preflop program, signed Release B, etc.). Prefer appending a dated section over rewriting earlier eras. Do not treat this file as the parity ledger — evidence still belongs in `FEATURE_PARITY.md` with the demonstrating commit.
