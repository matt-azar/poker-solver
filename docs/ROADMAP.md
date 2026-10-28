# Roadmap to a complete Pio-like solver

Planning baseline: October 27, 2026. Repository: matt-azar/poker-solver, branch `cursor/kuhn-vanilla-cfr`, reviewed through `2d6738657aa0ec78aa208aaf37c909459bbe8cb5`. Cursor implements; ChatGPT supplies mathematical review, milestone specifications, and independent verification. This roadmap supplements the conditional-action-EV specification; it does not replace that specification or authorize implementing the whole backlog in one pass.

## 1. What “finished” means

Build a reliable heads-up NLHE study application with the solving, analysis, automation, persistence, training, and interface capabilities of PioSolver/PioViewer. Target functional and workflow parity with our own design and implementation, rather than identical artwork or undocumented internal algorithms. Include the Edge-style preflop workflow in the final target, not just postflop.

Freeze the initial comparison target at the documented PioSolver 3.11 release. Its release notes include custom trainer themes and multiline training scenarios [S1]. Pio's manual explicitly says it is not exhaustive [S2]. Consequently, this is a complete implementation roadmap, but a claim of exhaustive feature parity requires a version-pinned, hands-on menu and workflow audit. Unverified details must remain marked unverified; do not quietly redefine “all features” to mean the features already implemented.

Separate three releases:

| Release | User outcome | Required scope |
|---|---|---|
| A: dependable postflop study tool | Build, solve, inspect EV/equity, save, reopen, and continue a useful postflop solution | M0–M5, core M6, release hygiene |
| B: complete postflop workstation | Efficient broad-range betting solves, node locks, reports, queues, trainer, profiling, rake/ICM, polished UI | M0–M11 and applicable M13 gates |
| C: full frozen-reference coverage | Add validated preflop solving and close every audited reference-feature gap | M12–M13 and entire parity ledger |

Do not call release A full Pio parity. Do not call a feature finished merely because its endpoint exists. Finish its numerical semantics, failure behavior, saved-state behavior, UI, tests, and documentation.

## 2. Starting point and evidence

We already have a substantial tested foundation: Kuhn/Leduc reference games, river and street engines, pass-frozen CFR variants, active-player CFR+ flooring, correct counterfactual reach handling, compact blocker-aware showdowns, deterministic first-public-card parallelism, enforced engine allocation budgets, and node-scoped browsing. The current budget defaults to 1024 MiB and threads default to one.

The latest Windows report is 364,982 assertions / zero failures. Independent GCC review of this commit passed 364,907 assertions; Windows HTTP tests are skipped there. Session-focused ThreadSanitizer passed 56 assertions on the review host, not the whole application. There is still a confirmed publication exception-safety defect: serialization can throw after the session has already marked a solution completed. Fix that first.

Completed-average conditional action EV is specified but not implemented. Saved solve files, continuation workflows, node locks, broad analysis tools, full tree editing, tournament/rake utilities, production packaging, and preflop remain substantial work. No head-to-head Pio performance or solution-quality equivalence has been established.

Full-range check-down is a scalability fixture, not proof of convergence on a broad betting tree. Existing timed betting fixtures and pinned raw-table comparisons remain valuable regression evidence. Preserve their provenance; do not reinterpret old timings under a new protocol.

## 3. Feature coverage ledger

Create `docs/FEATURE_PARITY.md` as the living inventory. Each leaf feature needs: reference version/source, observed behavior, current status, milestone, acceptance test/demo, limitations, and evidence commit. Use states `unverified`, `missing`, `partial`, `verified`, and `not applicable with explanation`. A family-level checkmark cannot stand in for every option inside it.

| Feature family | Current position | Delivery |
|---|---|---|
| Heads-up postflop CFR, chance, blocker handling, best responses | Established foundation; continue independent tests | M0, M6 |
| Conditional combo/action EV; both-player values | Specified, pending | M1 |
| Equity, action ranges, distributions, hand categories | Limited browsing foundation | M2 |
| Weighted range editing, range libraries, board input | Basic configuration; complete visual workflow needed | M2–M3 |
| Configurable betting trees and visual line editing | Basic parameters exist | M3 |
| Stop-and-keep, pause/continue, accuracy stopping | Cancellation exists; distinct semantics needed | M4 |
| Full saves, resumable checkpoints, compact saves, lazy load | Missing | M5, M10 |
| Broad practical betting-tree scale and competitive convergence | Small benchmark set; parity unproven | M6 |
| Full and combo node locking, editing, re-solving | Missing | M7 |
| Rake, ICM, opponent incentives | Missing; payoff architecture changes needed | M8 |
| Turn/river and multi-flop aggregation, filtered reports | Missing | M9 |
| Scriptable engine, durable batch queue, exports | Basic endpoints/CLI; production coverage missing | M9 |
| Drill trainer, packs, session statistics, hand histories | Missing | M11 |
| Preflop solver, weighted flop subsets, chart editor | Missing | M12 |
| Side-by-side grids, custom layouts, shortcuts, themes, localization | Basic web explorer | Across milestones; close in M13 |
| Stable delivery, help, upgrade/recovery, complete validation | Development workflow | Continuous; M13 release gate |

The audit must also inspect small utilities: standalone equity calculator, preflop chart image export, clipboard formats, all-lines/line-frequency views, strategy simplification tools, range selection predicates, links/bookmarks, report exports, settings persistence, and diagnostics. Determine exact reference behavior before claiming each utility matches. Compare desktop Pro/Edge capabilities; PioCloud hosting, commercial licensing infrastructure, and proprietary file compatibility are separate scope decisions, not silently promised core features.

## 4. Ordered implementation milestones

### M0 — Preserve the baseline and make publication atomic

Implement the already specified exception-safety fix: construct potentially throwing completed-status data before committing result ownership or terminal phase. Test throwing publication callbacks on both acceptance and cancellation paths. Preserve stop-before-publication, stop-after-completion, stale-job handling, retirement-before-replacement, and reader lifetime rules.

Pin compiler/build, configuration hashes, test fixtures, metric conventions, and benchmark protocols. Establish CI for Windows Release and Linux Release, plus targeted sanitizer jobs on supported hosts. Report skipped tests explicitly. Begin the parity ledger and record a short reference-product workflow for each feature family.

**Gate:** publication failure exposes no result; current numerical/UI/session tests pass. This is a focused fix, not a lifecycle rewrite.

### M1 — Conditional action EV

Implement the separate detailed EV specification already delivered. Force the selected legal action once, then follow the completed average strategy for both players. Support zero-probability actions and supported hands with zero own strategic reach. Normalize by compatible opponent reach; zero opponent support gives an undefined value, not zero.

Preserve explicit player signs and the existing root-centered net-chip utility. Keep actual reach and counterfactual EV availability distinct. Expose the query explicitly; ordinary status and navigation stay cheap. Show per-combo action EV and mixed EV, with correct weighted group aggregation and visible units.

**Gate:** independent pair-and-runout oracle agreement, exact turn-bluff fixtures, root EV reconstruction, no table mutation, bounded query workspace, stale-response and lifetime tests. No new 300-iteration campaign unless solver behavior changes.

### M2 — Range and equity analysis with a useful study screen

Create a shared range model/editor: 13×13 grid, exact combos, arbitrary nonnegative weights, brush/select controls, text import/export, copy/paste, undo/redo, presets and named folders. Clearly distinguish input weights, strategy-conditioned weights, compatible-pair marginals, and combo counts.

Add exact showdown equity per combo and range, conditional on the current board and compatible opponent distribution. Define whether an equity display assumes check-down; do not confuse it with strategic EV. Add equity distributions, made-hand/draw/backdoor categories, filtering, and range composition. Support a standalone equity-calculator workflow.

Build coordinated OOP/IP grids, selected-combo details, all-action strategy bars, equity/EV modes, range-after-action views, and runout switching that preserves the intended betting history where legal. Make missing/unsupported data visibly different from zero.

**Gate:** independent weighted equity enumeration including ties/blockers; aggregate totals reconcile; range text and grid round-trip; no accidental average of unweighted hand categories. A user can explain one mixed strategy and compare adjacent runouts without exporting the entire tree.

### M3 — Complete tree configuration and visual editing

Version a canonical game/tree configuration. Include board, initial contributions/dead money, effective stacks, weighted ranges, and per-player/per-street bet, raise, and donk settings. Specify pot percentages, chip amounts, raise multiples, geometric sizing, rounding, minimum legal raises, short all-ins, all-in thresholds, size merging, and deduplication.

Pio's documented builder includes sizing expressions, betting caps, forced lines and line editing [S3]. Turn these into leaf items in our ledger, including less-used spread-limit/limit-style options if required for literal reference coverage. Do not conflate a size restriction with a node lock.

Add a visual tree preview with add/remove/force line operations, explicit canonical action labels, saved templates, and a pre-build memory plan. Distinguish estimated engine allocation from measured allocation and whole-process memory. Validate before destructive replacement of a useful current solution.

**Gate:** canonical configuration rebuilds the same tree; every displayed sizing rule has legal-edge-case tests; edits invalidate derived results; failed estimates/builds explain the offending configuration. Curated small trees match independent enumerators.

### M4 — Solve control that preserves useful work

Introduce separate operations: cancel-and-discard, stop-and-keep, pause at a safe boundary, resume, and finish at a target. Existing cancellation must retain its tested semantics. A stop-and-keep publishes only a coherent evaluated average at a complete algorithm boundary; cancellation during construction cannot manufacture a result.

Provide iteration, elapsed-time and measured-gap targets, configurable evaluation cadence, convergence history, and honest progress information. Gap targets can only be declared achieved at an actual evaluated checkpoint. Support continuing the exact algorithm state without resetting regrets, average weights, or iteration numbering.

Design immutable solution revisions and an exclusive training owner. Browsing and training may use snapshots only when budgeted; otherwise suspend browsing with an explicit UI state. Do not silently double RAM to make everything simultaneous.

**Gate:** uninterrupted N+M iterations equal N then resume M under the same deterministic implementation. Gates cover pause/stop/replace/failure races without sleeps. Users can stop a long solve, inspect it, then improve it.

### M5 — Reliable saves, reload and recovery

Define a versioned native container with configuration, structural fingerprint, action/combo order, algorithm/version parameters, iteration/averaging state, precision, utility model, locks, and checksums. Separate a study snapshot from a resumable training checkpoint; they are not interchangeable.

Implement atomic save/replace, load validation, bounded decompression and allocations, corruption/truncation handling, unsupported-version errors, and migration fixtures. Rebuild disposable rank caches rather than storing machine-specific layouts unnecessarily. Include recent files, folders/tags, previews, and explicit overwrite behavior in the UI.

**Gate:** fresh-process load reproduces strategies, values, node queries and configuration; continuation matches an uninterrupted run. Interrupted writes preserve the prior file. Over-budget load fails cleanly without leaking the old/new engine. Full-size saves work before compact/lazy formats.

### M6 — Practical scale and competitive time-to-accuracy

Run this workstream alongside product development, but land changes separately. Build a benchmark corpus spanning river/turn/flop, broad and narrow ranges, varied boards, asymmetric distributions, multiple bet sizes/raises, and representative stacks. Include cold construction/cache fill, training, evaluation, browsing and peak memory.

Evaluate algorithm alternatives such as discounted or predictive regret methods with exact documented update/averaging semantics. Do not assume implementing DCFR means matching Pio's proprietary solver. Pio 3.10 documents a newer algorithm and different memory/performance modes [S4]. Choose by measured time to a common quality target, not iterations per second.

Investigate exact suit isomorphisms, compact slot indexing, memory layout, SIMD, task granularity, best-response parallelism and reduced-precision storage. Exact symmetry reduction must respect board, weighted ranges, locks and incentives; arbitrary suit-asymmetric inputs can destroy a symmetry. Approximate bucketing is an explicitly labeled mode, never a silent replacement for exact postflop cards.

Address stored-index limits with checked wider/segmented representations when required. Keep the small enumerator as an oracle; removing its cap is not the scale strategy. Add explicit hardware profiles rather than promising full preflop or rich flop trees inside 1 GiB.

**Gate:** each optimization passes an appropriate oracle/parity gate and budget failure tests. Algebra-preserving kernel changes should retain pins; algorithm/precision changes require quality comparisons rather than forced raw-table equality. Publish same-machine paired measurements, including evaluation cost and variance. Multi-size full-range betting trees must converge within a declared hardware envelope before broad practical parity is claimed.

### M7 — Strategy editing, node locking and constrained re-solving

Implement immutable scenario forks, manual strategy editing, full-node and selected-combo locks, validated probability rows, lock visualization, copy/paste, presets, undo, unlock and reset. Pio separates changing a stored strategy from preventing selected hands from being updated [S5]; our UI must make the same conceptual distinction clear.

Locked actions remain part of reach, terminal values, averaging, and opponent optimization. Specify warm-start versus reset behavior. General partial-action constraints, if supported, need a precise feasible-probability set rather than ad hoc renormalization.

Add baseline-versus-modified comparison: strategy changes, both-player EV changes, and where the response changes. Recompute the correct metrics for a constrained game. Report constrained deviation gains separately from unrestricted gains against the resulting profile.

**Gate:** tiny locked games agree with independent exact optimization; locked rows never drift; unlocked rows respond; saves preserve locks; all cached analyses invalidate on revision changes. An end-to-end demo edits a tendency, locks it, solves a response, and compares results without destroying the baseline.

### M8 — Rake, ICM and opponent incentives

First introduce a payoff abstraction returning both players' actual utilities. The current global-player-0 vectors and sign inversion are valid for the current zero-sum model only. Rake, ICM and incentives can invalidate that shortcut. Each best response must maximize its own utility.

Implement rake rate/cap and explicit collection/rounding rules with examples. Implement tournament utility tables and an ICM calculator/import path with stacks, payouts and interpolation validation. Then add documented action/category/runout incentive rules, previews, scenario identity and persistence. Keep chip EV and modeled utility separately labeled.

Pio exposes rake/ICM configuration and opponent profiling [S6, S7]. Our convergence claims must follow the actual game: ordinary two-player zero-sum CFR guarantees do not automatically extend to general-sum models. Use both unilateral deviation gains as empirical diagnostics; evaluate solver behavior independently before labeling a model supported. Do not assume that forcing a constant-sum surrogate preserves incentives.

**Gate:** terminal payouts match independent examples; each player's best response is independently checked; metric labels and units remain correct. General-sum fixtures converge to the declared tolerance or the mode reports its limitation instead of claiming a guaranteed equilibrium. Zero-rake/plain-chip mode retains existing results.

### M9 — Reports, automation and batch solving

Deliver runout aggregation first: turn/river tables of action frequencies, EV/equity and hand-category breakdowns, sorting/filtering, charts and CSV. Extend to multi-flop reports over explicitly weighted board sets with board-texture filters. Pio's 3.9 release specifically adds richer flop aggregation [S8].

Every report states its weighting measure. Combine underlying compatible-pair masses; do not average row percentages or normalized EVs indiscriminately. Distinguish ex-ante board frequency, frequency conditional on reaching a line, and an intentionally uniform study-board sample.

Version the engine command/API contract and expose all supported core operations independently of the UI. Add scripting examples, schema discovery, deterministic exits/errors and streaming progress. A UPI-compatible adapter is an optional separately tested interoperability layer; our internal API need not copy UPI.

Build a persistent job queue: templates × boards × scenarios, sequential default execution, resource admission, pause/retry/cancel, restart recovery, logs, checksummed output manifests, and report generation. Isolate failures by job. Include self-play hand-history export with documented semantics and supported target formats.

**Gate:** generated reports match a direct small-tree aggregation oracle; CLI and UI produce equivalent results; interrupted batches resume without silently losing or duplicating completed work. Start with a small reproducible board subset, then scale.

### M10 — Compact saves, fast browsing and subtree reconstruction

After full save correctness, add indexed/chunked storage, optional compression, lazy loading and bounded eviction. Specify which operations require full materialization. Pio documents partial loads and compact saves with omitted streets [S9].

Treat omitted-street reconstruction as a separate mathematical feature. Persist sufficient boundary information and define the reconstruction algorithm, target accuracy and permitted operations. Solving a subtree against only a naive range snapshot does not automatically preserve the full-game strategic guarantees. Distinguish an exact stored-node load from an approximate recomputation.

**Gate:** full and lazy representations agree on stored data; reconstructed results satisfy a published error/quality contract against full saves. Truncated/compressed corruption fails safely; eviction respects active readers and budgets. Measure file size, cold/warm load, first-node latency and reconstruction time.

### M11 — Trainer and study sessions

Build training packs from saved solutions and scenario filters: position, board texture, hand category, action history, street and selected lines. Sample legal deals from the declared distribution, not independently from incompatible marginal ranges. Provide reproducible seeds and a diagnostic mode that oversamples rare situations while labeling that sampling choice.

Deliver table view, action controls, instant/delayed feedback, combo strategy and EV, local decision cost, review history, bookmarks, and session statistics. Do not penalize a legitimate mixed action merely because its frequency is low. Explain the difference between local EV loss and whole-strategy exploitability.

Add multi-spot packs, multiline drills, keyboard operation, customizable table themes and bounded extension support. Pio's newer trainer emphasizes targeted filters and immediate on-table feedback [S10]; 3.11 adds themes and multiline sessions [S1]. Keep theme execution isolated from solver/session state.

**Gate:** legal-deal sampling passes exact small-distribution checks; feedback reproduces M1 values; seeded sessions replay; loading a wrong/missing solution revision fails explicitly; a complete drill/review workflow works without developer tools.

### M12 — Preflop research and implementation

Treat this as a separate major program after the postflop engine, saved formats and automation are stable. Start with exact small games, then a heads-up preflop tree with blinds, positions, initial contributions, limps, opens, reraises, all-ins and proper postflop transitions. “6-max BTN versus BB” can describe starting ranges; it does not turn this into a multiway solver.

Add weighted flop subsets, conditional card-removal probabilities, postflop tree templates per preflop exit, suit mapping and range transport. Pio's documented preflop construction composes preflop lines, postflop exits and flop subsets [S11]. Its Edge offering identifies preflop as requiring substantially more hardware [S12].

Write a memory/time feasibility study before a large implementation. Decide exact versus abstracted dimensions explicitly. If using buckets, compressed boundaries or sampled boards, version the abstraction and report its error scope. Measure deviation gains in the solved restricted game; do not label them exploitability of unrestricted NLHE.

Provide preflop grid views, range export, chart creation/images, subset management, batch solving and continuation. Establish a workstation-scale benchmark plan rather than making the current laptop the success criterion.

**Gate:** forced small subsets agree with brute-force composition; total chance mass and suit remaps are correct; increasing subset/abstraction fidelity produces documented stability results. Compare selected matched preflop trees with the reference. Only then mark Edge-style parity complete.

### M13 — Reference audit, interface completion and release

Finish the feature ledger against an actual pinned reference installation. Walk every relevant menu, dialog, configuration field and complete user journey. Record evidence and close discrepancies; a missing reference installation leaves the audit open, not implicitly passed.

Ship a coherent application: setup/library, tree builder, solve monitor, analysis browser, range explorer, scenarios/locks, reports/queue, trainer, settings/help. Add resizable saved layouts, two-player grids, consistent bet colors, suit palettes, scalable text, tooltips explaining units, accessible focus order, shortcuts, localization and documentation. Include saved-solution/node bookmarks and deep links with explicit revision identity. Pio's browser/layout and URI features provide reference workflows [S13, S14].

Deliver an installer/package for the primary platform, versioned settings, upgrade migration, crash diagnostics, clean shutdown, offline operation and testable uninstall behavior. Keep the local analysis server bound to the intended interface; validate imported files and control requests. Packaging and UI polish should land throughout development, not wait for this milestone.

**Gate:** a fresh-machine user can install, configure a game, solve to a stated quality, inspect a rare runout, save/reopen/resume, lock and compare a scenario, queue reports, and complete a drill without a terminal. Every parity-ledger item has evidence or a prominently stated limitation. Full reference parity cannot be declared with unresolved required items.

## 5. Cross-cutting contracts

Use explicit domain objects for game configuration, public tree, algorithm state, immutable solution revision, payoff model, analysis result and persistent manifest. Keep their versions separate. Query caches must key the exact profile, game, utility and constraints. A changed range, lock or payoff invalidates derived values.

Keep a primary service/API boundary between engine and interface. GUI, CLI, reports and trainer must consume the same value/range semantics rather than reimplementing poker math independently. Standardize IDs, units, errors and cancellation before more clients accumulate.

Continue engine-owned allocation charging. New EV workspaces, readers, report caches, queue workers and decompression buffers need explicit ownership and limits; native stacks/RSS exclusions remain visible. A resource limit must fail safely, not silently lower solve accuracy or drop actions.

Preserve these mathematical invariants: card removal, fixed pair-conditional chance, supported zero-own-reach counterfactuals, own-reach averaging, pass-level update contracts, consistent utility signs, and immutable published analysis. Do not require zero-sum identities in non-zero-sum modes.

## 6. How we establish quality and speed parity

Define a matching-case manifest: board/ranges with weights, pot/contributions, stacks, every betting line, rake/ICM, payoff convention, algorithm settings, thread count and precision. Verify the games match before comparing outputs.

Pio reports the average of the two unilateral best-response improvements; our existing NashConv is their sum. Convert explicitly before comparing accuracy [S15]. For ordinary chip EV, reconcile root-centered and reference display conventions with known fold/call examples.

Compare best-response quality, root EV, representative combo/action EV and aggregate strategies. Different equilibrium mixtures can be equally valid; exact action-frequency equality is not a universal cross-solver requirement. Use independent tiny-game oracles and, where supported, cross-evaluate exported profiles.

Measure time to the same normalized deviation target on matched trees and hardware. Separate cold/warm starts, cache init, training, evaluation and end-to-end wall. Record compiler, power state, thermal conditions, memory, repetition order and variance. Benchmark Pio's actual pinned algorithm; do not compare against a historic marketing number.

Choose explicit release service-level targets after measuring a representative corpus: solve time at stated quality, largest supported tree per RAM tier, first-node latency, cached navigation latency, save/load time and cancellation response. Do not invent a universal speed promise now. A useful initial correctness target for ordinary postflop benchmarks is measured NashConv/pot at or below 0.001, with stricter targets where practical; this is a planning gate, not proof of Pio performance parity.

## 7. Dependencies and execution policy for Cursor

The main path is M0 → M1 → M2 → M3 → M4 → M5. Performance M6 runs as a separately reviewed stream after M0. M7 needs M1/M4 and scenario persistence. M8 needs the numerical contract and payoff refactor. M9 needs stable configurations, analysis and saves. M10 depends on M5/M6; M11 depends on M1/M2/M5; M12 depends on demonstrated M6 scale plus M5/M9. M13 is continuous, with a final audit after all required features land.

Start now with the existing three-commit EV plan: publication fix; numerical evaluator plus oracle tests; opt-in API/UI. Next deliver range/equity analysis, tree configuration, solve continuation, and full saves. Do not jump directly to preflop, a new solver algorithm, or a cosmetic UI rebuild.

For each milestone: write a small specification, identify invariants and failure modes, implement reviewable commits, run relevant checks, demonstrate the user workflow, then update the ledger with exact evidence. Keep changes on the development branch unless explicitly instructed otherwise. Preserve accepted tests; do not rerun costly historical campaigns solely because a UI label changed.

Do not attach a completion percentage or calendar deadline to this backlog yet. Product work, exact solver scale, general-sum modes, compact reconstruction and preflop carry very different uncertainty. Estimate each milestone after its design spike, track actual cycle time, and revise forecasts at release gates. Completing the tested CFR kernel was a major foundation; completing an entire analysis product is a separate substantial effort.

## 8. Sources and reference boundaries

Official reference material checked October 27, 2026. These sources establish reference features; milestone designs, ordering and acceptance criteria above are our engineering recommendations. Pio's speed claims are vendor claims, not our independent measurements.

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

Phase 10 is a limit, not a solve. Unrestricted heads-up no-limit Hold'em is not computed by these trees. [HUNL.md](HUNL.md) records that, and records one measured alternative weighting, linear CFR, on Kuhn.

