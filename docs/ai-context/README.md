# AI context packs

Markdown packs written **for model consumption**, not for players. The desktop app injects packs into system prompts for the Study assistant.

| Pack | File | Used when |
| --- | --- | --- |
| **Unified Study assistant** | [unified.md](unified.md) | Floating Study assistant (Q&A + setup mutations) |
| Product help section | [help.md](help.md) | Folded into unified / help-only answers |
| Setup mutation section | [setup-assistant.md](setup-assistant.md) | Folded into unified / OpenAI setup tool path |

## Product intent

The AI is **deeply integrated**: one persistent, hideable, movable, resizable chat can answer questions, modify Build parameters, change settings that map to the study draft, and build/load ranges — always through validated app paths (catalogue / guarded generation / interpolation → `SpotDraft`), never by inventing unverified equilibrium charts as fact.

## Rules for editing

- Keep packs short, factual, and product-accurate.
- Do not invent GTO frequencies or unshipped features.
- Sync material changes from player-facing docs (`DESKTOP_UI.md`, `STUDY_SETUP_ASSISTANT.md`) into these packs in the same commit.
- Packs must not instruct the model to emit shell commands, executable paths, or API keys.

## Bundling

`desktop/src/domain/assistant/contextPacks.ts` imports these files as Vite `?raw` strings.
