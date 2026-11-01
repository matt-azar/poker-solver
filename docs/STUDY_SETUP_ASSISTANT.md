# Study setup assistant

Natural-language study creation and setup edits for the desktop Build workspace. The assistant interprets a request, resolves range profiles and derived quantities in application code, then applies a draft through the same `SpotDraft` path as manual edits.

## What players can do

From **Build → Setup assistant**:

- Prepare a CO vs BB SRP (and similar) study from a matching range profile
- Change the board, flop bet sizes, or duplicate a setup at another stack
- Review provenance, conflicts, and missing fields before applying
- Undo one applied assistant transaction
- Keep using manual Build controls if the provider fails

Supported example phrasing (demo/fake adapter and structured OpenAI tools):

- `Set up CO vs BB using my 100NL profile`
- `Change the flop to As 7d 2c`
- `Use 33% and 75% flop bets for IP`
- `Duplicate this setup at 150bb`
- `Use my alternative BB calling range`

"Prepare / Apply" updates Build only. **Solve** still uses the existing solve controls after validation.

## Range profiles

Versioned paired profiles live under `configs/range-profiles/` (import format) and ship as bundled synthetic fixtures for demos/tests under `desktop/src/domain/profiles/fixtures/`.

| Field | Role |
| --- | --- |
| `id` / `dataRevision` / `schemaVersion` | Stable identity; reopen uses the stored revision |
| `positions`, `preflopActions`, `startingStackBb` | Matching + pot/stack derivation |
| `ranges.oop` / `ranges.ip` | Weighted text for the existing parser |
| `provenance.classification` | `synthetic_fixture`, `population_estimate`, … |
| `legacyPreset` | Incomplete flat presets — never exact-matched |

Matching returns **exact**, labelled **alternatives**, or none. Stakes labels (e.g. `100NL`) never imply stack depth and never exact-match alone.

User imports persist in `localStorage` key `holdem-study-range-profiles`. Study applications store `{ profileId, dataRevision, ranges }` so reopening does not call a model or silently load a newer profile.

Bundled fixtures are **synthetic** and labelled as such — not verified 100NL population or equilibrium data.

## Resolution order

1. Explicit request fields  
2. Selected / exact-matched profile  
3. Compatible saved preferences (`holdem-study-setup-prefs`)  
4. Visible defaults  

Conflicts between explicit values and a profile surface for the player; they are not silently overridden. Pot/stack for SRP examples are derived in `derivePostflopPotAndStacks` (e.g. 100bb / 2.5bb open → 5.5bb pot, 97.5bb stack before rake).

## Provider / deployment

| Mode | Status |
| --- | --- |
| Fake adapter | Deterministic local interpreter for tests and demos |
| OpenAI adapter | Structured tool/function calling; default model `gpt-4.1-mini` |
| Credential in JS bundle / installer | **Not supported** — never commit keys |
| Browser prototype credential | Optional `localStorage` key `holdem-study-openai-key` (user-provided, outside source) |
| Tauri secure storage / backend proxy | Documented intent; not required for the fake demo path |

The standalone browser build needs a user-provided key or a future authenticated backend. Solving remains local via `explorer`.

External processing disclosure: the OpenAI path sends setup summaries, preference summaries, and profile **metadata** (ids, labels, stacks) — not full private range strings when identifiers suffice.

## Architecture map

| Piece | Path |
| --- | --- |
| Intent / patch / merge / derive | `desktop/src/domain/setup/` |
| Profiles / match / catalogue | `desktop/src/domain/profiles/` |
| Provider + resolve + session | `desktop/src/domain/assistant/` |
| Apply transaction + revision | `studyStore.applySetupDraft` |
| UI | `desktop/src/features/assistant/AssistantPanel.tsx` |

## Limits / unresolved

- Live OpenAI extraction quality is not gated in CI (credentials / cost / nondeterminism)
- No bundled production strategic pack — user import or synthetic fixtures only
- Full-draft undo covers assistant transactions; ordinary Build field edits still use range-only undo plus revision bumps
- Chat history is not persisted; study reproducibility uses draft + profile snapshot
- Strategy explanations and autonomous research are out of scope
