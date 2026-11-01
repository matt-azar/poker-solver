# Range profiles

Versioned JSON profiles that pair OOP/IP weighted ranges under shared game assumptions (positions, stack, open size, action history, format, rake metadata).

This catalogue sits **alongside** the flat text presets in `configs/ranges/*.txt`. Those legacy presets remain available via `GET /api/ranges` and can be wrapped for display with unknown assumptions (`legacyPreset: true`); they are never treated as automatic exact matches.

## Product naming

- **Rake structure** (e.g. `100NL`, `cEV`) selects the stakes/rake environment — not a personal player profile and not stack depth.
- **Pot type** (`SRP` / `3BP` / `4BP`) is required for matching create flows.
- Prefer **standard/GTO catalogue** language over “my profile”.

## Documented import path (Study desktop)

1. Open **Build → Range catalogue**.
2. Click **Import JSON…** and choose a schema-v1 file (this folder’s `fixture-*.json` files work as import demos).
3. The UI lists **rake / pot / seats / stack / open** columns, supports match filters, and can **Apply** a row onto Build through `prepareStudyFromProfile`.
4. User imports persist under the localStorage key `holdem-study-range-profiles` (bundled fixtures stay separate and cannot be removed).
5. Programmatic import: `catalogue.importProfile(rawJson)` in `desktop/src/domain/profiles/catalogue.ts`.

There is **no** bundled production strategic pack — only synthetic fixtures plus whatever you import.

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
| `labels` | Optional `{ stakes, site, pool, intendedUse }` — `stakes` is the rake-environment key |
| `ranges` | `{ oop, ip }` weighted combo text for the existing desktop parser (`AA`, `AKs`, `AKo:0.5`, `QQ+`, …) |
| `provenance` | `{ source, classification, notes? }` |
| `legacyPreset` | Optional; incomplete wrappers only |

`classification` must be one of: `equilibrium_model`, `population_estimate`, `personal_adjustment`, `synthetic_fixture`, `unknown`.

Applying a profile to a study snapshots `{ profileId, dataRevision, ranges }` so reopen does not need the live catalogue.

## Fixtures in this folder

Files named `fixture-*.json` are **synthetic**. They are for demos, imports practice, and automated matching tests only. They are **not** verified population or equilibrium data. Do not present them as production strategic packs.

| File | Shape |
| --- | --- |
| `fixture-co-bb-srp-100bb-2.5x.json` | CO vs BB SRP, cEV, 2.5x |
| `fixture-co-bb-srp-100bb-2.5x-100nl.json` | CO vs BB SRP, 100NL rake key, 2.5x |
| `fixture-co-bb-srp-100bb-3x.json` | CO vs BB SRP, cEV, 3x (alternative) |
| `fixture-btn-bb-3bp-100bb-100nl.json` | BTN vs BB 3BP, 100NL rake key |
