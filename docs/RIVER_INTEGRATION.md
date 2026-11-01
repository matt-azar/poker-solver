# River path (historical)

Planning date: October 30, 2026. Branch at the time: `cursor/river-integrate-c006`.

This note recorded the merge of overlapping river / five-card / payoff / solve-control stacks. That work landed on `main`. Current product path:

- Five-card boards solve on `StreetBatchSolver` (explorer and `river_solver`)
- `RiverGame` remains the five-card oracle
- `RiverBatchSolver` remains for internal oracle and legacy fixtures only

Living docs: [ARCHITECTURE.md](ARCHITECTURE.md), [RIVER.md](RIVER.md), [STREETS.md](STREETS.md), [ROADMAP.md](ROADMAP.md) M6.

## Original merge order (archive)

1. `#5` `payoff-dual-utility` — `PlayerPayoff` / `ChipPayoff` on `RiverGame`
2. `#12` `street-payoff` — `StreetGame::terminal_payoff` via `ChipPayoff`
3. `#15` `rake-payoff` — pot-rake on `ChipPayoff`
4. `#8` `explorer-street-river` (includes `#4` five-card) — explorer + `StreetBatch` for 3/4/5-card boards
5. `#3` `river-action-ev` — `RiverBatch` conditional EV fixtures; explorer keeps the shared street path for five-card
6. `#29` `eval-cadence` (includes `#10` time-limit + `#16` nash-history)
7. `#24` `strategy-report` — `--report` with `--time-limit` / `--eval-every`

Resolution then: new five-card solves always use `StreetBatchSolver`; `RiverBatchSolver` kept for older river-kind PSOL and oracle tests.
