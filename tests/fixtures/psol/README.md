# PSOL compatibility fixtures

Tiny checkpoints used as product compatibility pins for Open / Continue (Zig `formats` / `app` tests).

| File | Kind | Algorithm | Notes |
| --- | --- | --- | --- |
| `street_kind1_v2_cfrplus_tiny.psol` | 1 (street) | CFR+ | 1-combo turn tree, 4 iterations |
| `river_kind2_v2_cfrplus_tiny.psol` | 2 (river) | CFR+ | 1-combo river tree, 3 iterations |

## Provenance

The committed blobs are the pin. They match the `v0.1.2` wire layout: streaming write, versions 1–3, kinds 1–2. Update fixtures with a Zig writer and matching rematch tests.

## Contract covered by tests

- Kind / algorithm / iteration counts
- Combo order (`oop_combos` / `ip_combos`) and `slot_actions` shape
- Continue-from-fixture matches uninterrupted training for the remaining iters
- Ordering of combos, slots, actions, runouts, and public paths is part of the
  on-disk contract; changing that order requires a layout id + remap or a hard
  compatibility error
- In-memory slots are decision → runout → hand → action (ZR-129 Change A).
  PSOL v4 wire order remains decision → hand → runout → action; Session save/open
  remaps through `compile.buildPsolLayoutMap` without a layout-id bump
