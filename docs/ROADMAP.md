# Roadmap to a complete Pio-like solver

Planning baseline: October 27, 2026. Repository: matt-azar/poker-solver, branch `main`, reviewed through `2d6738657aa0ec78aa208aaf37c909459bbe8cb5`. Cursor implements; ChatGPT supplies mathematical review, milestone specifications, and independent verification. This roadmap supplements the conditional-action-EV specification. Each milestone is its own pass.

## 1. What “finished” means

Build a reliable heads-up NLHE study application with the solving, analysis, automation, persistence, training, and interface capabilities of PioSolver/PioViewer. Target functional and workflow parity in our own design and implementation. The final target includes postflop and the Edge-style preflop workflow.

The finished product is used through a modern, easy-to-use GUI. Numerical correctness and engine scale are required; they are incomplete until a player can configure a tree, solve it, inspect a line, save, resume, lock a scenario, and train without a terminal or developer tools. The current local explorer is the study surface for early milestones. A coherent desktop interface remains a release requirement.

Freeze the initial comparison target at the documented PioSolver 3.11 release. Its release notes include custom trainer themes and multiline training scenarios [S1]. Pio's manual covers a partial product [S2]. This is a complete implementation roadmap. Exhaustive feature parity requires a version-pinned, hands-on menu and workflow audit. Mark unverified details unverified. “All features” means the audited list.

Separate three releases:

| Release | User outcome | Required scope |
|---|---|---|
| A: dependable postflop study tool | Build, solve, inspect EV/equity, save, reopen, and continue a useful postflop solution | M0–M5, core M6, release hygiene |
| B: complete postflop workstation | Efficient broad-range betting solves, node locks, reports, queues, trainer, profiling, rake/ICM, polished UI | M0–M11 and applicable M13 gates |
| C: full frozen-reference coverage | Add validated preflop solving and close every audited reference-feature gap | M12–M13 and entire parity ledger |

Release A is the dependable postflop study tool in the table. A finished feature includes its numerical semantics, failure behavior, saved-state behavior, UI, tests, and documentation.

## 2. Starting point and evidence

We already have a substantial tested foundation: Kuhn/Leduc reference games, river and street engines, pass-frozen CFR variants, active-player CFR+ flooring, correct counterfactual reach handling, compact blocker-aware showdowns, deterministic first-public-card parallelism, enforced engine allocation budgets, and node-scoped browsing. The current budget defaults to 1024 MiB and threads default to one.

A flop, a turn, and a river are one betting tree with two, one, or zero cards still to come. `StreetGame` and `StreetBatchSolver` accept three-, four-, and five-card boards. Pinned five-card fixtures match `RiverGame` on strategies, values, and best response. The explorer routes five-card jobs through that shared tree. M6 finishes by moving `river_solver` onto the same path and retiring it as a separate product entry point. `RiverGame` stays the reference enumerator. Kuhn and Leduc stay on `CfrTrainer`.

The latest Windows report is 438,860 assertions / zero failures. Independent GCC review of the previous chance-page commit passed 364,907 assertions; Windows HTTP tests are skipped there. Session-focused ThreadSanitizer passed 56 assertions on the review host. That run covered the session tests. Publication now builds the completed status before it stores a terminal phase or a queryable result. If that builder throws, the job stays running and the existing failure path can record it.

Completed-average conditional action EV is implemented for flop and turn decision nodes. The profile cache follows training, reset, continuation, and explicit average edits. A stop after at least one completed iteration keeps that solve. A versioned solution file can be saved, closed, reopened, and continued. A chance node can list every legal next card with its conditional probability and both players' continuation EVs. Check-down equity is available from the strategy-conditioned reaches at a node and is labeled separately from chip EV. Made-hand category composition on five-card boards is available from strategy-weighted reaches; draws and backdoors are not. Node locks, compact saves, tournament/rake utilities, production packaging, and preflop remain substantial work. No head-to-head Pio performance or solution-quality equivalence has been established.

Full-range check-down measures whether a large tree fits and runs. Timed betting fixtures and pinned raw-table comparisons stay under the protocol that produced them.

## 3. Feature coverage ledger

The living inventory is [FEATURE_PARITY.md](FEATURE_PARITY.md). Each leaf feature needs: reference version/source, observed behavior, current status, milestone, acceptance test/demo, limitations, and evidence commit. Use states `unverified`, `missing`, `partial`, `verified`, and `not applicable with explanation`. Give every option inside a family its own row.

| Feature family | Current position | Delivery |
|---|---|---|
| Heads-up postflop CFR, chance, blocker handling, best responses | Established foundation. Shared tree accepts five-card boards and pins against `RiverGame`; explorer uses that tree for five cards; `river_solver` remains a CLI until M6 retires it | M0, M6 |
| Conditional combo/action EV; both-player values | Flop, turn, and river decision nodes on the shared street tree (RiverBatch still carries oracle fixtures) | M1 |
| Equity, action ranges, distributions, hand categories | Limited browsing foundation | M2 |
| Weighted range editing, range libraries, board input | Basic configuration; complete visual workflow needed | M2–M3 |
| Configurable betting trees and visual line editing | Basic parameters exist | M3 |
| Stop-and-keep, pause/continue, accuracy stopping | Cancellation and accuracy stopping exist; CLI `--time-limit` stops at an iteration boundary; `eval_every` / `--eval-every` sets Nash-gap eval cadence; accuracy evals record `nash_gap_history`; pause/continue still distinct | M4 |
| Full saves, resumable checkpoints, compact saves, lazy load | One versioned `PSOL` save/open/continue works (HTTP + GUI); compact/lazy formats still missing | M5, M10 |
| Broad practical betting-tree scale and competitive convergence | Small benchmark set; parity unproven | M6 |
| Full and combo node locking, editing, re-solving | Missing | M7 |
| Rake, ICM, opponent incentives | Pot-rake model + tests on `ChipPayoff` (`docs/RAKE.md`); ICM/incentives and street/river wiring still missing | M8 |
| Turn/river and multi-flop aggregation, filtered reports | Missing | M9 |
| Scriptable engine, durable batch queue, exports | Basic endpoints/CLI; production coverage missing | M9 |
| Drill trainer, packs, session statistics, hand histories | Missing | M11 |
| Preflop solver, weighted flop subsets, chart editor | Missing | M12 |
| Modern study GUI: layouts, two-player grids, shortcuts, themes, localization | Basic web explorer | Land with each feature; finish in M13 |
| Stable delivery, help, upgrade/recovery, complete validation | Development workflow | Continuous; M13 release gate |

The audit must also inspect small utilities: standalone equity calculator, preflop chart image export, clipboard formats, all-lines/line-frequency views, strategy simplification tools, range selection predicates, links/bookmarks, report exports, settings persistence, and diagnostics. Determine exact reference behavior before claiming each utility matches. Compare desktop Pro and Edge. PioCloud hosting, commercial licensing, and proprietary file compatibility enter the ledger only after an explicit scope decision.

## 4. Ordered implementation milestones

### M0 — Preserve the baseline and make publication atomic

The publication exception-safety fix is in the session. CI pins, the parity ledger, and the reference-product workflow in this milestone are still open.

Implement the already specified exception-safety fix: construct potentially throwing completed-status data before committing result ownership or terminal phase. Test throwing publication callbacks on both acceptance and cancellation paths. Preserve stop-before-publication, stop-after-completion, stale-job handling, retirement-before-replacement, and reader lifetime rules.

Pin compiler/build, configuration hashes, test fixtures, metric conventions, and benchmark protocols. Establish CI for Windows Release and Linux Release, plus targeted sanitizer jobs on supported hosts. Report skipped tests explicitly. Begin the parity ledger and record a short reference-product workflow for each feature family.

**Gate:** publication failure exposes no result; current numerical/UI/session tests pass.

### M1 — Conditional action EV

Flop, turn, and river decision nodes return these values. A generic export stays strategy-only.

Implement the separate detailed EV specification already delivered. Force the selected legal action once, then follow the completed average strategy for both players. Support zero-probability actions and supported hands with zero own strategic reach. Normalize by compatible opponent reach; zero opponent support leaves the value undefined.

Preserve explicit player signs and the existing root-centered net-chip utility. Keep actual reach and counterfactual EV availability distinct. Expose the query explicitly; ordinary status and navigation stay cheap. Show per-combo action EV and mixed EV, with correct weighted group aggregation and visible units.

**Gate:** independent pair-and-runout oracle agreement, exact turn-bluff fixtures, root EV reconstruction, no table mutation, bounded query workspace, stale-response and lifetime tests. The profile epoch follows mutations, tiny compatible mass uses a direct sum, and the value worker joins on shutdown. No new 300-iteration campaign unless solver behavior changes. M1 stays open until those checks pass.

### M2 — Range and equity analysis with a useful study screen

Create a shared range model/editor: 13×13 grid, exact combos, arbitrary nonnegative weights, brush/select controls, text import/export, copy/paste, undo/redo, and presets. A flat named preset library under `configs/ranges` with explorer list/fetch is in place; nested folders remain open. Clearly distinguish input weights, strategy-conditioned weights, compatible-pair marginals, and combo counts.

Add exact showdown equity per combo and range, conditional on the current board and compatible opponent distribution. State whether an equity display assumes check-down, and keep that label separate from strategic EV. Check-down equity distributions are exposed as ten fixed buckets on the explorer equity JSON; a study-screen histogram, made-hand/draw/backdoor categories, filtering, and range composition remain. Support a standalone equity-calculator workflow.

Build coordinated OOP/IP grids, selected-combo details, all-action strategy bars, equity/EV modes, range-after-action views, and runout switching that preserves the intended betting history where legal. Make missing/unsupported data visibly different from zero.

**Gate:** independent weighted equity enumeration including ties/blockers; aggregate totals reconcile; range text and grid round-trip; no accidental average of unweighted hand categories. A user can explain one mixed strategy and compare adjacent runouts without exporting the entire tree.

### M3 — Complete tree configuration and visual editing

Version a canonical game/tree configuration. Include board, initial contributions/dead money, effective stacks, weighted ranges, and per-player/per-street bet, raise, and donk settings. Specify pot percentages, chip amounts, raise multiples, geometric sizing, rounding, minimum legal raises, short all-ins, all-in thresholds, size merging, and deduplication.

Pio's documented builder includes sizing expressions, betting caps, forced lines and line editing [S3]. Turn these into leaf items in our ledger, including less-used spread-limit/limit-style options if required for literal reference coverage. A size restriction and a node lock are separate ledger items.

Add a visual tree preview with add/remove/force line operations, explicit canonical action labels, saved templates, and a pre-build memory plan. Distinguish estimated engine allocation from measured allocation and whole-process memory. Validate before destructive replacement of a useful current solution. `street_solver --plan-memory` and `plan_street_memory` expose the labeled engine peak for a config without training; a mid-construction dry-run that avoids allocating the remaining buffers is still open.

**Gate:** canonical configuration rebuilds the same tree; every displayed sizing rule has legal-edge-case tests; edits invalidate derived results; failed estimates/builds explain the offending configuration. Curated small trees match independent enumerators.

### M4 — Solve control that preserves useful work

Introduce separate operations: cancel-and-discard, stop-and-keep, pause at a safe boundary, resume, and finish at a target. Existing cancellation must retain its tested semantics. A stop-and-keep publishes a coherent evaluated average at a complete algorithm boundary. Cancellation during construction publishes nothing.

Provide iteration, elapsed-time and measured-gap targets, configurable evaluation cadence, convergence history, and honest progress information. CLI `--time-limit` and `SolveConfig::max_wall_seconds` stop at an iteration boundary and set `SolveStats::time_limit_reached`. `SolveConfig::eval_every` (default 1; CLI `--eval-every`, rejecting non-positive values) controls how often a thresholded solve measures the Nash gap. When a Nash-gap threshold is set, each accuracy evaluation appends to `SolveStats::nash_gap_history` (and `nash_gap_iterations`) at that cadence. Gap targets can only be declared achieved at an actual evaluated checkpoint. Support continuing the exact algorithm state without resetting regrets, average weights, or iteration numbering.

Design immutable solution revisions and an exclusive training owner. Browsing and training use a snapshot when the budget has room for one. Otherwise suspend browsing and show that state.

**Gate:** uninterrupted N+M iterations equal N then resume M under the same deterministic implementation. Gates cover pause/stop/replace/failure races without sleeps. Users can stop a long solve, inspect it, then improve it.

### M5 — Reliable saves, reload and recovery

Define a versioned native container with configuration, structural fingerprint, action/combo order, algorithm/version parameters, iteration/averaging state, precision, utility model, locks, and checksums. Store a study snapshot and a resumable training checkpoint as separate files.

Implement atomic save/replace, load validation, bounded decompression and allocations, corruption/truncation handling, unsupported-version errors, and migration fixtures. Rebuild disposable rank caches at load time. A bounded recent-files MRU (sidecar + explorer dropdown/API) is in place; folders/tags, previews, and explicit overwrite behavior in the UI remain.

**Gate:** fresh-process load reproduces strategies, values, node queries and configuration; continuation matches an uninterrupted run. Interrupted writes preserve the prior file. Over-budget load fails cleanly without leaking the old/new engine. Full-size saves work before compact/lazy formats.

### M6 — Practical scale and competitive time-to-accuracy

Run this workstream alongside product development, but land changes separately. Build a benchmark corpus spanning river/turn/flop, broad and narrow ranges, varied boards, asymmetric distributions, multiple bet sizes/raises, and representative stacks. Include cold construction/cache fill, training, evaluation, browsing and peak memory.

Evaluate algorithm alternatives such as discounted or predictive regret methods, and document the exact update and averaging semantics. Pio 3.10 documents a newer algorithm and different memory and performance modes [S4]. Choose a method by measured time to a common quality target.

Investigate exact suit isomorphisms, compact slot indexing, memory layout, SIMD, task granularity, best-response parallelism and reduced-precision storage. Exact symmetry reduction must respect board, weighted ranges, locks and incentives; arbitrary suit-asymmetric inputs can destroy a symmetry. Approximate bucketing is its own labeled mode. Exact postflop cards remain the default.

Address stored-index limits with checked wider/segmented representations when required. Keep the small enumerator as an oracle. Scale one batch solver, and publish a hardware profile for each supported tree size, including which trees fit in 1 GiB.

Solve a five-card board in that same production tree. Cards still to come are two, one, or zero. A turn tree already solves a river after each river card; the standalone river solver is that subtree entered with the turn card known. `StreetGame` and `StreetBatchSolver` already accept a five-card board and match `RiverGame` on the pinned fixtures. The explorer now routes five-card jobs through that shared tree. Finish by moving `river_solver` onto the same path, then remove it as a separate product entry point. `RiverGame` remains the oracle for the zero-card case, on the same footing as `--reference` against `StreetGame`. Do this before scaling the flop/turn kernel and the river kernel as two products.

**Gate:** each optimization passes an appropriate oracle/parity gate and budget failure tests. A five-card public tree matches `RiverGame` on the pinned river fixtures before `river_solver` is removed as a product entry point. Algebra-preserving kernel changes should retain pins; algorithm and precision changes are compared on solution quality. Publish same-machine paired measurements, including evaluation cost and variance. Multi-size full-range betting trees must converge within a declared hardware envelope before broad practical parity is claimed.

### M7 — Strategy editing, node locking and constrained re-solving

The immutable node-lock data model landed in `include/solver/node_lock.hpp` (full-node and selected-combo locks, validated probability rows, `LockSet`, text round-trip) with unit coverage in `tests/unit/test_node_lock.cpp`. CFR application, UI editing, and constrained re-solving remain ahead.

Implement immutable scenario forks, manual strategy editing, full-node and selected-combo locks, validated probability rows, lock visualization, copy/paste, presets, undo, unlock and reset. The UI separates editing a stored strategy from locking selected hands against later updates [S5].

Locked actions remain part of reach, terminal values, averaging, and opponent optimization. Specify warm-start versus reset behavior. General partial-action constraints, when supported, use an explicit feasible-probability set.

Add baseline-versus-modified comparison: strategy changes, both-player EV changes, and where the response changes. Recompute the correct metrics for a constrained game. Report constrained deviation gains separately from unrestricted gains against the resulting profile.

**Gate:** tiny locked games agree with independent exact optimization; locked rows never drift; unlocked rows respond; saves preserve locks; all cached analyses invalidate on revision changes. An end-to-end demo edits a tendency, locks it, solves a response, and compares the result with the baseline still available.

### M8 — Rake, ICM and opponent incentives

The dual-player payoff abstraction is in place: `PlayerPayoff` holds both utilities, and `ChipPayoff` reproduces today's root-centered chip rule with `utility[1] == -utility[0]`. `RiverGame::terminal_payoff` and `StreetGame::terminal_payoff` use that adapter; CFR loops still consume the player-0 scalar. Pot-rake rate/cap collection (whole-chip floor, optional cap) is implemented on `ChipPayoff` with pinned zero-rake and positive-rake fixtures in `docs/RAKE.md`; it is not yet passed through the street/river solve path. ICM and incentives still need both players' actual utilities. Each best response must maximize its own utility.

Wire rake into the solve path next. Implement tournament utility tables and an ICM calculator/import path with stacks, payouts and interpolation validation. Then add documented action/category/runout incentive rules, previews, scenario identity and persistence. Keep chip EV and modeled utility separately labeled.

Pio exposes rake/ICM configuration and opponent profiling [S6, S7]. State convergence claims for the game that was solved. Zero-sum CFR guarantees cover the zero-sum chip model. Use both unilateral deviation gains as diagnostics, and check a general-sum model on its own fixtures before calling it supported. Check a constant-sum surrogate against the incentives it is meant to represent.

**Gate:** terminal payouts match independent examples; each player's best response is independently checked; metric labels and units remain correct. General-sum fixtures reach the declared tolerance, or the mode states its limitation. Zero-rake/plain-chip mode retains existing results.

### M9 — Reports, automation and batch solving

A first stable export is in: `street_solver` and `river_solver` accept `--report` and write a versioned `strategy-report 1` document (solve summary plus the root decision mixture). Deliver runout aggregation next: turn/river tables of action frequencies, EV/equity and hand-category breakdowns, sorting/filtering, charts and CSV. Extend to multi-flop reports over explicitly weighted board sets with board-texture filters. Pio's 3.9 release specifically adds richer flop aggregation [S8].

Every report states its weighting measure. Weight each report by compatible-pair mass. Distinguish ex-ante board frequency, frequency conditional on reaching a line, and an intentionally uniform study-board sample.

Version the engine command/API contract and expose all supported core operations independently of the UI. Add scripting examples, schema discovery, deterministic exits/errors and streaming progress. A UPI-compatible adapter is an optional interoperability layer with its own tests.

Build a persistent job queue: templates × boards × scenarios, sequential default execution, resource admission, pause/retry/cancel, restart recovery, logs, checksummed output manifests, and report generation. Isolate failures by job. Include self-play hand-history export with documented semantics and supported target formats.

**Gate:** generated reports match a direct small-tree aggregation oracle; CLI and UI produce equivalent results; an interrupted batch resumes with each completed job kept once. Start with a small reproducible board subset, then scale.

### M10 — Compact saves, fast browsing and subtree reconstruction

After full save correctness, add indexed/chunked storage, optional compression, lazy loading and bounded eviction. Specify which operations require full materialization. Pio documents partial loads and compact saves with omitted streets [S9].

Treat omitted-street reconstruction as a separate mathematical feature. Persist sufficient boundary information and define the reconstruction algorithm, target accuracy and permitted operations. State the guarantee that comes with solving a subtree from a range snapshot. An exact stored-node load and an approximate recomputation are separate operations.

**Gate:** full and lazy representations agree on stored data; reconstructed results satisfy a published error/quality contract against full saves. Truncated/compressed corruption fails safely; eviction respects active readers and budgets. Measure file size, cold/warm load, first-node latency and reconstruction time.

### M11 — Trainer and study sessions

Build training packs from saved solutions and scenario filters: position, board texture, hand category, action history, street and selected lines. Sample legal deals from the declared joint distribution. Provide reproducible seeds and a diagnostic mode that oversamples rare situations while labeling that sampling choice.

Deliver table view, action controls, instant/delayed feedback, combo strategy and EV, local decision cost, review history, bookmarks, and session statistics. Score a mixed action by its EV, including low-frequency actions in the mix. Show local EV loss and whole-strategy exploitability as separate numbers.

Add multi-spot packs, multiline drills, keyboard operation, customizable table themes and bounded extension support. Pio's newer trainer emphasizes targeted filters and immediate on-table feedback [S10]; 3.11 adds themes and multiline sessions [S1]. Keep theme execution isolated from solver/session state.

**Gate:** legal-deal sampling passes exact small-distribution checks; feedback reproduces M1 values; seeded sessions replay; loading a wrong/missing solution revision fails explicitly; a complete drill/review workflow works without developer tools.

### M12 — Preflop research and implementation

Treat this as a separate major program after the postflop engine, saved formats and automation are stable. Start with exact small games, then a heads-up preflop tree with blinds, positions, initial contributions, limps, opens, reraises, all-ins and proper postflop transitions. “6-max BTN versus BB” names starting ranges for a heads-up tree.

Add weighted flop subsets, conditional card-removal probabilities, postflop tree templates per preflop exit, suit mapping and range transport. Pio's documented preflop construction composes preflop lines, postflop exits and flop subsets [S11]. Its Edge offering identifies preflop as requiring substantially more hardware [S12].

Write a memory/time feasibility study before a large implementation. Decide exact versus abstracted dimensions explicitly. If using buckets, compressed boundaries or sampled boards, version the abstraction and report its error scope. Report deviation gains as exploitability of the solved restricted game.

Provide preflop grid views, range export, chart creation/images, subset management, batch solving and continuation. Set the benchmark on workstation-scale hardware.

**Gate:** forced small subsets agree with brute-force composition; total chance mass and suit remaps are correct; increasing subset/abstraction fidelity produces documented stability results. Compare selected matched preflop trees with the reference. Only then mark Edge-style parity complete.

### M13 — Reference audit, interface completion and release

Finish the feature ledger against an actual pinned reference installation. Walk every relevant menu, dialog, configuration field and complete user journey. Record evidence and close discrepancies; a missing reference installation leaves the audit open.

Ship a coherent application used through a modern, easy-to-use GUI: setup/library, tree builder, solve monitor, analysis browser, range explorer, scenarios/locks, reports/queue, trainer, settings/help. Add resizable saved layouts, two-player grids, consistent bet colors, suit palettes, scalable text, tooltips explaining units, accessible focus order, shortcuts, localization and documentation. Include saved-solution/node bookmarks and deep links with explicit revision identity. Pio's browser/layout and URI features provide reference workflows [S13, S14]. The interface is a product surface: fast to learn, dense enough for daily study, and complete enough that the CLI is optional.

Deliver an installer/package for the primary platform, versioned settings, upgrade migration, crash diagnostics, clean shutdown, offline operation and testable uninstall behavior. Keep the local analysis server bound to the intended interface; validate imported files and control requests. Land packaging and GUI work with the features they belong to. Early explorer screens stay reviewable. The finished interface is the M13 surface.

**Gate:** a fresh-machine user can install, configure a game, solve to a stated quality, inspect a rare runout, save/reopen/resume, lock and compare a scenario, queue reports, and complete a drill in the GUI, without a terminal. Every parity-ledger item has evidence or a prominently stated limitation. Full reference parity requires every required ledger item to be resolved.

## 5. Cross-cutting contracts

Use explicit domain objects for game configuration, public tree, algorithm state, immutable solution revision, payoff model, analysis result and persistent manifest. Keep their versions separate. Query caches must key the exact profile, game, utility and constraints. A changed range, lock or payoff invalidates derived values.

Keep a primary service/API boundary between engine and interface. GUI, CLI, reports, and the trainer read values and ranges from the engine. Standardize IDs, units, errors and cancellation before more clients accumulate.

Continue engine-owned allocation charging. New EV workspaces, readers, report caches, queue workers and decompression buffers need explicit ownership and limits; native stacks/RSS exclusions remain visible. A resource limit fails the operation. Accuracy and the action set stay as configured.

Preserve these mathematical invariants: card removal, fixed pair-conditional chance, supported zero-own-reach counterfactuals, own-reach averaging, pass-level update contracts, consistent utility signs, and immutable published analysis. Zero-sum identities apply in zero-sum modes.

## 6. How we establish quality and speed parity

Define a matching-case manifest: board/ranges with weights, pot/contributions, stacks, every betting line, rake/ICM, payoff convention, algorithm settings, thread count and precision. Verify the games match before comparing outputs.

Pio reports the average of the two unilateral best-response improvements; our existing NashConv is their sum. Convert explicitly before comparing accuracy [S15]. For ordinary chip EV, reconcile root-centered and reference display conventions with known fold/call examples.

Compare best-response quality, root EV, representative combo/action EV and aggregate strategies. Different equilibrium mixtures can share the same quality. Use independent tiny-game oracles and, where supported, cross-evaluate exported profiles.

Measure time to the same normalized deviation target on matched trees and hardware. Separate cold/warm starts, cache init, training, evaluation and end-to-end wall. Record compiler, power state, thermal conditions, memory, repetition order and variance. Benchmark Pio's pinned algorithm on the same machine.

Choose explicit release service-level targets after measuring a representative corpus: solve time at stated quality, largest supported tree per RAM tier, first-node latency, cached navigation latency, save/load time and cancellation response. An initial correctness target for ordinary postflop benchmarks is measured NashConv/pot at or below 0.001, with stricter targets where the tree allows.

## 7. Dependencies and execution policy for Cursor

The main path is M0 → M1 → M2 → M3 → M4 → M5. Performance M6 runs as a separately reviewed stream after M0 and includes joining the five-card production path to the shared postflop tree before the two current kernels are scaled separately. M7 needs M1/M4 and scenario persistence. M8 needs the numerical contract and payoff refactor. M9 needs stable configurations, analysis and saves. M10 depends on M5/M6; M11 depends on M1/M2/M5; M12 depends on demonstrated M6 scale plus M5/M9. M13 is continuous, with a final audit after all required features land.

Check-down equity, equity-distribution buckets, made-hand category composition on five-card boards, stop-and-keep, one resumable solution file, runout EV comparison, and a bounded recent-files list for Save/Open paths, and saved street-config templates, and named range presets are implemented and covered by the unit tests. They are not a completed M2 or a Pio parity claim. Draw/backdoor categories, node locking, and compact saves are still ahead.

For each milestone: write a small specification, identify invariants and failure modes, implement reviewable commits, run relevant checks, demonstrate the user workflow, then update the ledger with exact evidence. Keep changes on the development branch unless explicitly instructed otherwise. Keep accepted tests. Rerun a historical campaign when the solver behavior it checks has changed.

Estimate each milestone after its design spike. Product work, exact solver scale, general-sum modes, compact reconstruction, and preflop have different uncertainty. Track actual cycle time and revise forecasts at release gates. The tested CFR kernel is the foundation. The remaining work is the analysis product and a modern, easy-to-use GUI that presents it.

## 8. Sources and reference boundaries

Official reference material checked October 27, 2026. These sources establish reference features; milestone designs, ordering and acceptance criteria above are our engineering recommendations. Pio's speed claims are the vendor's measurements.

- [S1: PioSolver 3.11 release](https://piosolver.com/blog/2026-10-01-trainer-skins/) — themes, multiline trainer scenarios and UI changes.
- [S2: User manual scope](https://piosolver.com/docs/viewer/) — documentation explicitly non-exhaustive.
- [S3: Postflop tree building](https://piosolver.com/docs/viewer/postflop_tree_building/) — sizing, caps, forced/edited lines.
- [S4: PioSolver 3.10 release](https://piosolver.com/blog/2026-07-01-new-alg/) — new algorithm and compressed saves.
- [S5: Node locking](https://piosolver.com/docs/viewer/node_locking/) — editing, full-range and combo locks.
- [S6: UPI commands](https://piosolver.com/docs/upi/commands/) — engine operations, rake and ICM configuration.
- [S7: Opponent profiling](https://piosolver.com/blog/2023-12-28-incentives/) — incentives and tendencies.
- [S8: Flop aggregation](https://piosolver.com/blog/2026-02-04-flop-aggregation-reports/) — board/hand category reports.
- [S9: Saving trees](https://piosolver.com/docs/viewer/saving_trees/) — partial/full loads and operation restrictions; [feature overview](https://piosolver.com/docs/feature_overview/) for omitted-street saves.
- [S10: Trainer redesign](https://piosolver.com/blog/2025-07-20-new-trainer/) — packs, filters and feedback.
- [S11: Preflop construction commands](https://piosolver.com/docs/upi/commands/) — preflop exits, schematic trees and subsets.
- [S12: Product comparison](https://piosolver.com/docs/product_comparison/) — Pro/Edge scope and preflop hardware expectations.
- [S13: Feature overview](https://piosolver.com/docs/feature_overview/) and [release history](https://piosolver.com/blog/) — browsing, analysis and layouts.
- [S14: Viewer URI links](https://piosolver.com/docs/viewer/uri_protocol/) — navigation integration.
- [S15: Meaning of numbers](https://piosolver.com/docs/viewer/numbers_in_piosolver/) — weights, matchups, EV and reported exploitability.

## Appendix: historical phases 1-10

The phases below were the kernel plan through the baseline reviewed above. They are complete. Section 2 is the starting point for the milestones in this document.

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Complete |
| 5. Hold’em cards, evaluator, ranges | Complete |
| 6. Heads-up river solver | Complete |
| 7. Performance optimization | Complete |
| 8. Turn and flop solving | Complete |
| 9. Graphical strategy explorer | Complete |
| 10. Full HUNL research | Complete |

Phase 10 records the scope of these trees. [HUNL.md](HUNL.md) describes that scope and one measured alternative weighting, linear CFR, on Kuhn.

