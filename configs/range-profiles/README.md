# Range profiles

Versioned JSON catalogue entries that pair OOP/IP weighted ranges under shared game assumptions (positions, stack, open size, action history / pot type, format, rake environment).

This catalogue sits **alongside** the flat text presets in `configs/ranges/*.txt`. Those legacy presets remain available via `GET /api/ranges` and can be wrapped for display with unknown assumptions (`legacyPreset: true`); they are never treated as automatic exact matches.

## Matching keys

Standard/GTO-style matching uses:

- Positions (postflop OOP / IP)
- Prefop pot type / action history (`SRP` / `3BP` / `4BP`)
- Starting stack (bb)
- Rake / stakes-environment label (`cEV`, `100NL`, …)
- Format and open size when constrained

`100NL` is a **rake structure**, not a personal player profile and not stack depth. When the player omits a rake structure, the assistant assumes **cEV** (chip EV / no rake). When stack depth is omitted, it assumes **100bb**.

## Import format

Each file is a single JSON object matching schema version 1:

| Field | Notes |
| --- | --- |
| `schemaVersion` | Integer ≥ 1 (currently `1`) |
| `id` | Stable string id |
| `dataRevision` | String or number; bumps when weights/assumptions change |
| `displayName` | UI label |
| `format` | e.g. `cash_6max`, `cash_9max`, `unknown` |
| `playerCount` | Table size |
| `positions` | `{ "oop": "BB", "ip": "CO" }` |
| `preflopActions` | Ordered `{ position, kind, sizeBb? }` history |
| `startingStackBb` | Effective starting stack in bb |
| `blinds` | `{ sb, bb }` |
| `antes` | Optional |
| `rake` | `{ rate, cap, collection, known }` — set `known: false` when unverified |
| `labels` | Optional `{ stakes, site, pool, intendedUse }` — `stakes` is the rake-environment key (`cEV`, `100NL`, …) |
| `ranges` | `{ oop, ip }` weighted combo text for the existing desktop parser (`AA`, `AKs`, `AKo:0.5`, `QQ+`, …) |
| `provenance` | `{ source, classification, notes? }` |
| `legacyPreset` | Optional; incomplete wrappers only |

`classification` must be one of: `equilibrium_model`, `population_estimate`, `personal_adjustment`, `synthetic_fixture`, `unknown`.

User imports in the Study UI persist under the localStorage key `holdem-study-range-profiles`. Applying an entry to a study should snapshot `{ profileId, dataRevision, ranges }` so reopen does not need the live catalogue.

## Fixtures in this folder

Files named `fixture-*.json` are **synthetic**. They are for demos and automated matching tests only. They are **not** verified production population or equilibrium data. Do not present them as production strategic packs.

| File | Role |
| --- | --- |
| `fixture-co-bb-srp-100bb-2.5x.json` | cEV CO vs BB SRP 100bb 2.5x (default silence path) |
| `fixture-co-bb-srp-100bb-3x.json` | cEV alternative 3x open |
| `fixture-co-bb-srp-100bb-2.5x-100nl.json` | Same spot labelled for the **100NL** rake environment |
