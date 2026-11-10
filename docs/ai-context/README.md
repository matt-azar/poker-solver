# AI context packs

Markdown packs written **for model consumption**, not for players. The desktop app injects packs into system prompts for the Study assistant.

| Pack | File | Used when |
| --- | --- | --- |
| **Unified Study assistant** | [unified.md](unified.md) | Floating Study assistant (Q&A + setup mutations) |
| Product help section | [help.md](help.md) | Folded into unified / help-only answers |
| Setup mutation section | [setup-assistant.md](setup-assistant.md) | Folded into unified / OpenAI setup tool path |

## How packs stay fresh

**Single source of truth:** edit fragments under [`source/`](source/), then regenerate the three packs.

| Fragment | Role |
| --- | --- |
| [`source/surface.md`](source/surface.md) | Mounted UI (workspaces, Assistant entry, Build/Settings controls, apply UX) |
| [`source/setup-rules.md`](source/setup-rules.md) | Pot type / 100NL / fieldEdits / catalogue rules |
| [`source/help-body.md`](source/help-body.md) | Help-only workflow + numerical labels |
| [`source/unified-extra.md`](source/unified-extra.md) | Tools, snapshot, out-of-scope |

```bash
# After editing source fragments:
cd desktop && npm run sync:ai-context

# CI / local guard (fails if packs drifted or forbidden stale UI phrases reappear):
cd desktop && npm run check:ai-context
```

`check:ai-context` also:

- Diffs committed packs against a fresh assembly from `source/`
- Rejects stale phrases (Help → Study assistant, Build Setup assistant, title-case «Flop donk» control label, …)
- Confirms claimed Build labels still exist in `BuildWorkspace.tsx` and that menu bar **Assistant** + Equity workspace remain mounted
- Scans [`STUDY_SETUP_ASSISTANT.md`](../STUDY_SETUP_ASSISTANT.md) for the same forbidden phrases

Player-facing product docs ([DESKTOP_UI.md](../DESKTOP_UI.md), [STUDY_SETUP_ASSISTANT.md](../STUDY_SETUP_ASSISTANT.md)) stay in sync with `source/surface.md` in the same change when the mounted UI moves.

## Product intent

The AI is **deeply integrated**: one persistent, hideable, movable, resizable chat can answer questions, modify Build parameters, change settings that map to the study draft, and build/load ranges — always through validated app paths (catalogue / guarded generation / interpolation → `SpotDraft`), never by inventing unverified equilibrium charts as fact.

## Rules for editing

- Prefer editing `source/*.md`, then `npm run sync:ai-context`. Do not hand-edit generated `help.md` / `setup-assistant.md` / `unified.md` except via the script.
- Keep packs short, factual, and product-accurate.
- Do not invent GTO frequencies or unshipped features.
- Packs must not instruct the model to emit shell commands, executable paths, or API keys.

## Bundling

`desktop/src/domain/assistant/contextPacks.ts` imports the generated files as Vite `?raw` strings.
