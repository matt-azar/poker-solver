# Refreshing AGENT_LESSONS.md

Playbook for scheduled (or manual) updates to [`AGENT_LESSONS.md`](AGENT_LESSONS.md) from recent agent / PR work.

## Goal

Keep the lessons doc current with durable traps agents rediscover. Prefer short **Do / Don't / Symptom** entries over narrative. Skip pure CSS / copy polish unless it encodes a recurring product contract (e.g. no Flop donk control).

## Cadence

- **Cursor Automation (preferred):** weekly schedule against `matt-azar/poker-solver` using the prompt below. Create at [cursor.com/automations](https://cursor.com/automations) (or `/automate`). Repository must be attached — cron defaults otherwise run with no repo.
- **Also useful:** GitHub **Pull request merged** trigger on this repo with the same prompt narrowed to “only if this merge taught a new trap.”
- Manual: any agent may follow this playbook when asked.

## Sources to mine

1. Merged PRs since the last `AGENT_LESSONS.md` edit (`gh pr list --state merged`, `git log -- docs/auxiliary/engineering/AGENT_LESSONS.md`).
2. Recent cloud agents with code changes (`cursor-cloud` list-cloud-agents / batch-fetch-details transcripts — skim conclusions, do not dump full JSON).
3. CI flakes and follow-up commits that fixed agent mistakes (lock scope, analysis thrash, `tsc -b`, paths-filter, wall-clock asserts).

## What to update together

| File | When |
| --- | --- |
| `docs/auxiliary/engineering/AGENT_LESSONS.md` | New durable trap or corrected stale claim |
| `.cursor/rules/parallel-agents.mdc` | Trap belongs in every agent’s always-on digest |
| `AGENTS.md` | Entry-point wording or must-read pointers change |

Do **not** change `LICENSE`. Do **not** mark roadmap rows done from a lessons refresh alone.

## Automation prompt (paste into Cursor Automations)

```text
Repository: matt-azar/poker-solver (single repo). Open a PR only when AGENT_LESSONS.md (and digest files if needed) actually change.

Task: Refresh docs/auxiliary/engineering/AGENT_LESSONS.md from recent agent/PR lessons.

Follow docs/auxiliary/engineering/AGENT_LESSONS_REFRESH.md exactly.

Steps:
1. Read AGENT_LESSONS.md, AGENTS.md, and .cursor/rules/parallel-agents.mdc.
2. Find the last commit that touched AGENT_LESSONS.md.
3. List merged PRs and notable agent runs since then.
4. Extract durable engineering traps not already covered (correctness, architecture, Study EV/equity lifecycle, locks, configs, CI, assistant/context packs, parallel-agent ops). Skip one-off styling.
5. Update AGENT_LESSONS.md with concise Do/Don't entries and PR/commit pointers.
6. If a trap belongs in always-on context, update the short digest in .cursor/rules/parallel-agents.mdc and AGENTS.md.
7. If nothing new: make no commit; say so and exit.
8. If changes: branch cursor/agent-lessons-refresh-<shortid> from origin/main, commit, push, open PR base main with a short summary of new lessons. Do not change LICENSE or FEATURE_PARITY rows.
```

## Acceptance

- New entries are actionable and non-duplicative.
- Always-on digest still fits a short rule file.
- PR body lists which PRs/agents produced each new lesson.
