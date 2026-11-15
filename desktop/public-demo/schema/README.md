# Public Study demo — manifest schema (v1)

Stable schema for precomputed Hold’em Study demo packs exported from Zig `solver-engine`.

| Path | Role |
| --- | --- |
| `manifest.v1.schema.json` | JSON Schema for per-example `manifest.json` |
| This README | Semantics for board, ranges, bet sizes, EV/equity units, chunks |

## Served artifacts

Exporter writes URL-fetchable packs under `desktop/public/demo/` (Vite `/demo/…`):

```text
desktop/public/demo/
  catalog.json
  flop-explore/
    manifest.json
    inputs/flop-explore.txt
    baseline/{status,locks,index,expected}.json
    baseline/{nodes,values,equity}/<node_id>.json
  river-lock/
    manifest.json
    inputs/river-lock.txt
    baseline/…
    oop-always-check/… + lock_preset.json
```

Saved street-config inputs also live at `scripts/public-demo/configs/`.

## Units and labels (must match Study)

| Field | Contract |
| --- | --- |
| `ev_units` | `"chips"` — host `values.units` |
| `utility_basis` | `"local"` — Fold≈0; dual `root_centered` may also be present |
| `equity_units` | `"fraction of the pot"` — check-down equity ≠ chip EV |
| `combo_weights` | Acting-seat `reach` / `marginal` on `node` bodies |
| `action_labels` | Host Study strings (`Check`, `Bet 50`, `Bet 100 all-in`, …) |
| `engine_build_sha` | `git rev-parse HEAD` when the pack was exported |

## Chunk / lazy load

- One JSON file per public node under `nodes/`.
- Decision nodes also have `values/` + `equity/` siblings.
- Chance/terminal nodes are link-only (no values/equity files).
- Flop chance fan-out is sampled (`max_chance_children`, default 2); the chance node still lists every `cards[].child_id`.
- **Initial flop view** should fetch only catalog + manifest + root node/values/equity (see `chunk_layout.initial_view`).

## Regenerate

```bash
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
python3 scripts/public-demo/export_solutions.py
# optional: --iterations 40 --resolve-iterations 40 --max-chance-children 2
```
