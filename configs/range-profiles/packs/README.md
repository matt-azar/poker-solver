# Reliable range packs (import here)

Bundled `fixture-*.json` files are **synthetic plumbing demos**. They are not study-quality GTO or population ranges.

## What belongs here

Drop schema-v1 paired JSON profiles from a **trusted source** you control, for example:

- Solver exports you generated (with known rake, pot type, seats, stacks)
- Licensed / purchased preflop range libraries you have rights to use
- Your own reviewed equilibrium or population models

Name files clearly, e.g. `co-bb-srp-100bb-2.5x-100nl.json`, set:

- `provenance.classification`: prefer `equilibrium_model` or `population_estimate`
- `labels.stakes`: rake environment (`cEV`, `100NL`, …)
- Distinct OOP vs IP weights for the actual seats

## How to load them into Study

1. **Build → Range catalogue → Import JSON…** (persists under `holdem-study-range-profiles`), or
2. Copy into this folder and wire a future pack loader / ship as user-provided assets (do not relabel synthetic fixtures as equilibrium).

Depth ladders (100 / 150 / 200bb, …) enable stack interpolation (e.g. 170bb blend). Import both bracket endpoints with matching pot type, seats, and rake.
