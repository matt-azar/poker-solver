# Study setup assistant

Natural-language study creation and setup edits for Hold'em Study. The assistant interprets a request, resolves standard/GTO catalogue ranges and derived quantities in application code, then applies a draft through the same `SpotDraft` path as manual edits.

The primary UX is the floating **Study assistant** (**Help → Study assistant…**): a hideable, movable, resizable chat available on every workspace. It answers product questions and proposes Build mutations (parameters, ranges, board, tree). Model-facing packs live under [`docs/ai-context/`](ai-context/README.md). The Build panel **Setup assistant** remains as an alternate entry for setup-only flows.

## What players can do

From **Help → Study assistant…** (or **Build → Setup assistant**):

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

## Range catalogue import

Preferred catalogue grain is **seat×action** atoms from Matt’s `Ranges.zip` (61 charts under `configs/range-profiles/packs/seat-action/`, e.g. `CO.txt`, `BBvCOcall.txt`). The assistant **composes** OOP/IP for a spot (SRP/3BP) from those atoms.

**Build → Range catalogue** also lists paired profiles and synthetic demos. Use **Import JSON…** for schema-v1 pair files; fixtures remain plumbing-only.

## Generated ranges & interpolation

When no catalogue row fits, the assistant may:

1. Emit **guarded `generatedRanges`** (validated weighted text) labelled `model_generated` — not equilibrium.
2. Set **`interpolateFromIds`** to two imported depth packs; app code blends per-combo weights (`linear_stack_blend`) labelled `interpolated`.

Exact catalogue match still preferred when a reliable pack exists.

## Provider / credentials

| Mode | Status |
| --- | --- |
| Fake adapter | Deterministic local interpreter for tests and demos |
| OpenAI adapter | Structured tool/function calling; default model `gpt-4.1-mini` |
| Credential in JS bundle / installer / source | **Not supported** — never commit keys |
| Tauri desktop prototype | Native commands `assistant_secret_*` store the key under the app config dir (`assistant_secrets.json`, mode `0600` on Unix) — outside the webview bundle. Not OS keychain / Stronghold yet. |
| Browser prototype credential | Optional `localStorage` key `holdem-study-openai-key`, or paste in the OpenAI provider UI |
| Authenticated backend proxy | **Not built** — required for a distributed product so clients do not hold long-lived vendor keys |

Credential lookup prefers Tauri storage when running inside the shell, then the browser prototype key. Solving remains local via `explorer`.

External processing disclosure: the OpenAI path sends setup summaries, preference summaries, and catalogue **metadata** (ids, labels, stacks, pot type) — not full private range strings when identifiers suffice.

## Live OpenAI eval (not ordinary CI)

Representative interpretation cases live in `desktop/src/domain/assistant/liveEvalCases.ts` (varied wording, missing pot type, 100NL vs 100bb, cEV default, SRP/3BP, …). Offline scoring is covered by `npm test`. The real adapter runs only when a key is present:

```bash
cd desktop
HOLDEM_STUDY_OPENAI_KEY=sk-... npm run test:assistant-live
# or OPENAI_API_KEY=...
```

Without a key the script exits 0 and reports `skipped`. Ordinary `npm test` / CI never call the live harness.

## Architecture map

| Piece | Path |
| --- | --- |
| Intent / patch / merge / derive | `desktop/src/domain/setup/` |
| Catalogue / match | `desktop/src/domain/profiles/` |
| Provider + resolve + session | `desktop/src/domain/assistant/` |
| Live eval cases + scoring | `desktop/src/domain/assistant/liveEvalCases.ts` |
| Live eval runner | `desktop/scripts/run-assistant-live-eval.mjs` |
| Credential lookup | `desktop/src/platform/credentials.ts` + Tauri `assistant_secret_*` |
| Apply transaction + revision | `studyStore.applySetupDraft` |
| UI | Floating `StudyAssistantWindow` (shell), Build `AssistantPanel.tsx`, `RangeCataloguePanel.tsx` |
| Model context packs | `docs/ai-context/` (`unified.md`, `help.md`, `setup-assistant.md`) |
| Unified chat router | `desktop/src/domain/assistant/unifiedChat.ts` |

## Limits / unresolved

- Live OpenAI field accuracy is measured by `npm run test:assistant-live` with credentials; not gated in ordinary CI (cost / nondeterminism)
- Floating chat geometry persists; message transcript is session-only (not durable)
- Deep integration today covers help answers + study-setup mutations (ranges/board/tree/stacks). Theme/layout toggles and starting Solve from chat are not yet tools.
- Tauri credential store is an app-config file, not OS keychain; distributed products should proxy through an authenticated backend
- Full-draft undo covers assistant transactions; ordinary Build field edits still use range-only undo plus revision bumps
- Strategy explanations and autonomous research remain out of scope for truthful GTO claims
