# Feature parity ledger

Planning date: October 28, 2026. Branch: `main`. The comparison target is the documented PioSolver 3.11 release. A hands-on menu audit of a pinned installation is still open, so leaf options are not split yet and no row is `verified` against that installation.

States: `unverified`, `missing`, `partial`, `verified`, `not applicable`.

| Family | Status | Milestone | Evidence in this repository | Limitation |
| --- | --- | --- | --- | --- |
| Heads-up postflop CFR, chance, blocker handling, best responses | partial | M0, M6 | Kuhn, Leduc, river, and street tests; public-tree solvers; blocker-aware showdown | Two production engines: `StreetBatchSolver` for three or four cards, `RiverBatchSolver` for five. M6 joins the five-card board to the shared tree. `RiverGame` stays the reference enumerator. No Pio solution-quality comparison. The CI workflow has not been executed on a GitHub runner from this checkout |
| Conditional combo and action EV | partial | M1 | Flop and turn decision query, oracle tests, and the values HTTP path | River page and generic export stay without values. M1 stays open until the review checks on profile invalidation, tiny compatible mass, and value-worker shutdown pass |
| Equity, action ranges, distributions, hand categories | partial | M2 | Node browse, action frequencies, chance-card marginals, check-down equity from strategy-conditioned reaches, and a runout EV table | No hand categories or range-composition report. Check-down equity is not chip EV. The default equity work limit can reject a full-range river |
| Weighted range editing and range libraries | partial | M2–M3 | 13×13 paint, weights, text ranges, and range-grid undo/redo | No libraries, folders, or import/export beyond the range text |
| Configurable betting trees and visual line editing | partial | M3 | Per-street sizes, geometric sizes, caps, donk sizes, all-in threshold, minimum-raise and short-all-in edges, a `street-config 1` round-trip, and `street_solver --config` | No visual line editor or saved templates |
| Stop-and-keep, pause, continue, accuracy stopping | partial | M4 | A stop after at least one completed iteration publishes that solve. Continuation keeps finished chunks. Accuracy stopping is unchanged | Pause is absent. A stop during construction, before any completed iteration, still publishes nothing |
| Full saves, checkpoints, compact saves, lazy load | partial | M5, M10 | One versioned `PSOL` file stores the canonical config, regrets, strategy sums, and completed iterations. Save and Open rebuild the tree and resume | No compact or multi-file library. This is not a Pio file and has not been checked against Pio |
| Broad betting-tree scale and competitive convergence | partial | M6 | Opt-in benches in [BENCHMARKS.md](BENCHMARKS.md) | No matched Pio timing or quality run |
| Node locking and constrained re-solving | missing | M7 | — | — |
| Rake, ICM, opponent incentives | missing | M8 | Chip utilities are zero-sum and root-centered | Payoff model is one player-0 vector |
| Reports, scripting, batch queue | partial | M9 | CLI solvers and the local HTTP explorer | No report aggregation, queue, or stable command schema |
| Trainer, packs, session statistics | missing | M11 | — | — |
| Preflop solver and chart editor | missing | M12 | — | — |
| Layouts, shortcuts, themes, localization | partial | M13 | One local page in `ui/` | No saved layouts or themes |
| Delivery, install, upgrade, recovery | partial | M13 | CMake build of the binaries; [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | No install package. Test and benchmark targets are still part of a full `cmake --build` |

Update a row only with the commit that demonstrates it. Historical phase 1–10 notes stay in [ROADMAP.md](ROADMAP.md).
