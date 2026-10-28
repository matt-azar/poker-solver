# Feature parity ledger

Planning date: October 28, 2026. Branch: `cursor/kuhn-vanilla-cfr`. The comparison target is the documented PioSolver 3.11 release. A hands-on menu audit of a pinned installation is still open, so leaf options are not split yet and no row is `verified` against that installation.

States: `unverified`, `missing`, `partial`, `verified`, `not applicable`.

| Family | Status | Milestone | Evidence in this repository | Limitation |
| --- | --- | --- | --- | --- |
| Heads-up postflop CFR, chance, blocker handling, best responses | partial | M0, M6 | Kuhn, Leduc, river, and street tests; public-tree solvers; blocker-aware showdown | No Pio solution-quality comparison. The CI workflow has not been executed on a GitHub runner from this checkout |
| Conditional combo and action EV | partial | M1 | Flop and turn decision query, oracle tests, and the values HTTP path | River page and generic export stay without values. M1 stays open until the review checks on profile invalidation, tiny compatible mass, and value-worker shutdown pass |
| Equity, action ranges, distributions, hand categories | partial | M2 | Node browse, action frequencies, chance-card marginals | No equity mode, categories, or range-composition report |
| Weighted range editing and range libraries | partial | M2–M3 | 13×13 paint, weights, text ranges | No libraries, folders, undo, or import/export beyond the range text |
| Configurable betting trees and visual line editing | partial | M3 | Per-street sizes, geometric sizes, caps, donk sizes, all-in threshold, minimum-raise and short-all-in edges, and a `street-config 1` round-trip | No visual line editor, saved templates, or `street_solver` loader for that document |
| Stop-and-keep, pause, continue, accuracy stopping | partial | M4 | Cancel-and-discard on a new solve. `POST /api/solutions/{id}/continue` adds iterations on the same solution id. A stop during that continuation keeps the finished chunks | Pause is absent. A stop before the first publication still discards the new solve |
| Full saves, checkpoints, compact saves, lazy load | missing | M5, M10 | — | No solve file format |
| Broad betting-tree scale and competitive convergence | partial | M6 | Opt-in benches in [BENCHMARKS.md](BENCHMARKS.md) | No matched Pio timing or quality run |
| Node locking and constrained re-solving | missing | M7 | — | — |
| Rake, ICM, opponent incentives | missing | M8 | Chip utilities are zero-sum and root-centered | Payoff model is one player-0 vector |
| Reports, scripting, batch queue | partial | M9 | CLI solvers and the local HTTP explorer | No report aggregation, queue, or stable command schema |
| Trainer, packs, session statistics | missing | M11 | — | — |
| Preflop solver and chart editor | missing | M12 | — | — |
| Layouts, shortcuts, themes, localization | partial | M13 | One local page in `ui/` | No saved layouts or themes |
| Delivery, install, upgrade, recovery | partial | M13 | CMake build of the binaries; [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | No install package. Test and benchmark targets are still part of a full `cmake --build` |

Update a row only with the commit that demonstrates it. Historical phase 1–10 notes stay in [ROADMAP.md](ROADMAP.md).
