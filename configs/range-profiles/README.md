# Range profiles

Versioned JSON profiles that pair OOP/IP weighted ranges under shared game assumptions (positions, stack, open size, action history, format, rake metadata).

This catalogue sits **alongside** the flat text presets in `configs/ranges/*.txt`. Those legacy presets remain available via `GET /api/ranges` and can be wrapped for display with unknown assumptions (`legacyPreset: true`); they are never treated as automatic exact matches.

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
| `labels` | Optional `{ stakes, site, pool, intendedUse }` |
| `ranges` | `{ oop, ip }` weighted combo text for the existing desktop parser (`AA`, `AKs`, `AKo:0.5`, `QQ+`, …) |
| `provenance` | `{ source, classification, notes? }` |
| `legacyPreset` | Optional; incomplete wrappers only |

`classification` must be one of: `equilibrium_model`, `population_estimate`, `personal_adjustment`, `synthetic_fixture`, `unknown`.

User imports in the Study UI persist under the localStorage key `holdem-study-range-profiles`. Applying a profile to a study should snapshot `{ profileId, dataRevision, ranges }` so reopen does not need the live catalogue.

## Fixtures in this folder

Files named `fixture-*.json` are **synthetic**. They are for demos and automated matching tests only. They are **not** verified 100NL population or equilibrium data. Do not present them as production strategic packs.
