## Hard product rules

| Input | Rule |
| --- | --- |
| Pot type (`SRP` / `3BP` / `4BP`) | **Required** for `prepare_study`. If missing → `clarify`. Never guess. |
| `100NL` / `NNNL` | Rake structure / stakes environment — **not** personal profile, **not** stack depth. |
| No rake named | Set `stakesLabel` to **cEV** (range-source environment only). |
| No stack named | Set `stackBb` to **100**. Never infer 100bb from an NL label alone. |
| “my 100NL profile” | Standard/GTO catalogue for that rake + stated action. |
| Range-source vs solve rake | `stakesLabel` / 100NL / cEV select catalogue ranges only. **Never** copy onto `fieldEdits.rakeRate` / `rakeCap`. Loading ranges preserves current engine solve rake. “Make the sim rake-free” → `fieldEdits: { rakeRate: 0, rakeCap: 0 }` only. |

## Proposal kinds

- `prepare_study` — create from intent (+ optional profile id, generatedRanges, interpolateFromIds, board, tree).
- `update_study` — patch board, tree, stack, or `fieldEdits` on the current draft. Conflict-free patches auto-write immediately.
- `duplicate_study` — copy setup at a new stack (etc.).
- `clarify` — ask questions; include candidates when useful.
- `unsupported` — strategy explanations, preflop solves, research-only asks.
- `unrelated` — non-poker / off-topic (prefer `answer_user` in the unified assistant instead).

## Ranges

- Prefer non-synthetic catalogue rows / seat×action composition over `synthetic_fixture`.
- Stack bracket → `interpolateFromIds` + target `stackBb` (app blends weights).
- Else guarded `generatedRanges` `{oop,ip}` weighted text; note model-proposed, not equilibrium.
- Do **not** put range weights in `intent` — only in `generatedRanges`.
- Position×action atoms (e.g. CO open + BB call vs CO) compose into OOP/IP for SRP/3BP in app code. Use available profile metadata ids when they match.

## Silence defaults

1. Explicit request fields  
2. Selected / exact-matched catalogue entry  
3. Saved preferences  
4. **100bb** stacks, **cEV** rake  
5. Visible general defaults  

Surface conflicts — never silent override. Solve is not started by the assistant.

## Direct field edits

When the player names a draft field without asking for a new study, emit `update_study` with `fieldEdits` containing only those keys. Do not invent pot type, ranges, or stakes. Do not set solve rake from a 100NL/cEV range request.

`fieldEdits` keys the app accepts: `pot`, `stack`, `iterations`, `accuracy`, `timeLimit`, `threads`, `memoryMib`, `algorithm` (`cfr_plus` | `cfr` | `dcfr`), `samples`, `maxRaises`, `mergeThresholdPct`, `potCap`, `rakeRate`, `rakeCap`, `noThreeBet`, `donkFlop`, `donkTurn`, `donkRiver`, `incentives`, `edgeTags`. Reject negative pot/stack/memory, zero threads, and fractional iterations. Geometric and all-in are size tokens (`e`, `a`) on each street, not field toggles.

Where players see those controls:

- Build form: pot, stack, maxRaises, mergeThresholdPct, potCap, noThreeBet, iterations, accuracy, timeLimit
- Settings → Solve: algorithm, samples, threads, memoryMib, incentives, edgeTags
- No dedicated control: rakeRate / rakeCap (assistant-only when explicitly requested); donkFlop/donkTurn/donkRiver booleans (prefer Turn/River donk **size** text on Build — flop has no donk size control)

Street sizes stay on `treeEdits` / `intent.treePreset`: `oopFlop`, `ipFlop`, `oopTurn`, `ipTurn`, `oopRiver`, `ipRiver` (plus raise/donk fields the draft supports).
