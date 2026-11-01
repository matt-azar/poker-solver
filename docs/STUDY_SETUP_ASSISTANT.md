# Study setup assistant

Natural-language study creation and setup edits for the desktop Build workspace. The assistant interprets a request, resolves standard/GTO catalogue ranges and derived quantities in application code, then applies a draft through the same `SpotDraft` path as manual edits.

## What players can do

From **Build → Setup assistant**:

- Prepare a CO vs BB SRP (and similar) study from a matching catalogue entry keyed by pot type, rake structure, positions, and stacks
- Change the board, flop bet sizes, or duplicate a setup at another stack
- Review provenance, conflicts, and missing fields before applying
- Undo one applied assistant transaction
- Keep using manual Build controls if the provider fails

Supported example phrasing (demo/fake adapter and structured OpenAI tools):

- `Set up CO vs BB SRP with 100NL ranges`
- `Set up CO vs BB SRP` (assumes **cEV** / no rake and **100bb** when those are omitted)
- `Change the flop to As 7d 2c`
- `Use 33% and 75% flop bets for IP`
- `Duplicate this setup at 150bb`
- `Use my alternative BB calling range`

"Prepare / Apply" updates Build only. **Solve** still uses the existing solve controls after validation.

## Range semantics (product rules)

Ranges are determined by **positions**, **preflop action / pot type** (SRP / 3BP / 4BP), **rake structure**, **stacks**, and related game assumptions — not by a personal “player profile” name.

| Input | Meaning |
| --- | --- |
| Pot type (`SRP` / `3BP` / `4BP`) | Required for create. If missing, the assistant asks — it does not guess. |
| `100NL` (and similar `NNNL`) | A **rake structure / stakes environment**, not a personal profile and not stack depth. |
| No rake structure named | Assume **cEV** (chip EV / no rake). |
| No stack depth named | Assume **100bb** preflop starting stacks. Still never infer 100bb from an `NL` label alone. |
| “my 100NL profile” | Product-meaningless as a personal profile. Treated as intent for **standard/GTO catalogue** ranges for that rake structure + the stated action. |

Matching prefers standard/GTO catalogue entries keyed by rake + action + positions + stacks. Exact match, labelled alternatives, or none — never a silent near substitution.

## Range catalogue

Versioned paired entries live under `configs/range-profiles/` (import format) and ship as bundled synthetic fixtures for demos/tests under `desktop/src/domain/profiles/fixtures/`.

| Field | Role |
| --- | --- |
| `id` / `dataRevision` / `schemaVersion` | Stable identity; reopen uses the stored revision |
| `positions`, `preflopActions`, `startingStackBb` | Matching + pot/stack derivation |
| `labels.stakes` | Rake/stakes-environment key (`cEV`, `100NL`, …) |
| `ranges.oop` / `ranges.ip` | Weighted text for the existing parser |
| `provenance.classification` | `synthetic_fixture`, `equilibrium_model`, `population_estimate`, … |
| `legacyPreset` | Incomplete flat presets — never exact-matched |

User imports persist in `localStorage` key `holdem-study-range-profiles`. Study applications store `{ profileId, dataRevision, ranges }` so reopening does not call a model or silently load a newer catalogue revision.

Bundled fixtures are **synthetic** and labelled as such — not verified production 100NL or equilibrium packs.

## Resolution order

1. Explicit request fields  
2. Selected / exact-matched catalogue entry  
3. Compatible saved preferences (`holdem-study-setup-prefs`)  
4. Silence defaults: **100bb** starting stacks, **cEV** rake environment  
5. Visible general defaults  

Conflicts between explicit values and a catalogue entry surface for the player; they are not silently overridden. Pot/stack for SRP examples are derived in `derivePostflopPotAndStacks` (e.g. 100bb / 2.5bb open → 5.5bb pot, 97.5bb stack before rake).

## Provider / deployment

| Mode | Status |
| --- | --- |
| Fake adapter | Deterministic local interpreter for tests and demos |
| OpenAI adapter | Structured tool/function calling; default model `gpt-4.1-mini` |
| Credential in JS bundle / installer | **Not supported** — never commit keys |
| Browser prototype credential | Optional `localStorage` key `holdem-study-openai-key` (user-provided, outside source) |
| Tauri secure storage / backend proxy | Documented intent; not required for the fake demo path |

The standalone browser build needs a user-provided key or a future authenticated backend. Solving remains local via `explorer`.

External processing disclosure: the OpenAI path sends setup summaries, preference summaries, and catalogue **metadata** (ids, labels, stacks, pot type) — not full private range strings when identifiers suffice.

## Architecture map

| Piece | Path |
| --- | --- |
| Intent / patch / merge / derive | `desktop/src/domain/setup/` |
| Catalogue / match | `desktop/src/domain/profiles/` |
| Provider + resolve + session | `desktop/src/domain/assistant/` |
| Apply transaction + revision | `studyStore.applySetupDraft` |
| UI | `desktop/src/features/assistant/AssistantPanel.tsx` |

## Limits / unresolved

- Live OpenAI extraction quality is not gated in CI (credentials / cost / nondeterminism)
- No bundled production strategic pack — user import or synthetic fixtures only
- Full-draft undo covers assistant transactions; ordinary Build field edits still use range-only undo plus revision bumps
- Chat history is not persisted; study reproducibility uses draft + catalogue snapshot
- Strategy explanations and autonomous research are out of scope
