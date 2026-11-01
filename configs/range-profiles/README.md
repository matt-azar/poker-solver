# Range profiles

Versioned JSON profiles that pair OOP/IP weighted ranges under shared game assumptions (positions, stack, open size, action history, format, rake metadata).

This catalogue sits **alongside** the flat text presets in `configs/ranges/*.txt`. Those legacy presets remain available via `GET /api/ranges` and can be wrapped for display with unknown assumptions (`legacyPreset: true`); they are never treated as automatic exact matches.

## Product naming

- **Rake structure** (e.g. `100NL`, `cEV`) selects the stakes/rake environment — not a personal player profile and not stack depth.
- **Pot type** (`SRP` / `3BP` / `4BP`) is required for matching create flows.
- Prefer **standard/GTO catalogue** language over “my profile”.
- Assistant may **generate** guarded ranges or **interpolate** between imported stack brackets; those paths are labelled `model_generated` / `interpolated` and are not equilibrium claims.

## Reliable packs vs fixtures

| Kind | Location | Use |
| --- | --- | --- |
| **Reliable packs** | `packs/` (your imports) + Build → Import JSON | Study-quality; set classification to `equilibrium_model` / `population_estimate` |
| **Synthetic fixtures** | `fixture-*.json` | Matcher / assistant plumbing tests only |

Fixtures deliberately use different OOP vs IP placeholder shapes but remain **wrong vs real GTO**. Do not study from them. See `packs/README.md`.

## Documented import path (Study desktop)

1. Open **Build → Range catalogue**.
2. Click **Import JSON…** and choose a schema-v1 file.
3. Match filters cover pot type and rake; nearest-neighbor ranking surfaces close rows when exact match fails.
4. **Apply** loads ranges through `prepareStudyFromProfile`.
5. User imports persist under `holdem-study-range-profiles`.

Programmatic: `catalogue.importProfile(rawJson)`.

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
| `ranges` | `{ oop, ip }` weighted combo text for the existing desktop parser |
| `provenance` | `{ source, classification, notes? }` |
| `legacyPreset` | Optional; incomplete wrappers only |

`classification` must be one of: `equilibrium_model`, `population_estimate`, `personal_adjustment`, `synthetic_fixture`, `model_generated`, `interpolated`, `unknown`.

## Fixtures in this folder

| File | Shape |
| --- | --- |
| `fixture-co-bb-srp-100bb-2.5x.json` | DEMO CO vs BB SRP cEV 2.5x |
| `fixture-co-bb-srp-100bb-2.5x-100nl.json` | DEMO CO vs BB SRP 100NL 2.5x |
| `fixture-co-bb-srp-100bb-3x.json` | DEMO CO vs BB SRP cEV 3x |
| `fixture-btn-bb-3bp-100bb-100nl.json` | DEMO BTN vs BB 3BP 100NL |
