# PSOL compatibility fixtures

Tiny checkpoints used as product compatibility pins for Open / Continue.

| File | Kind | Algorithm | Notes |
| --- | --- | --- | --- |
| `street_kind1_v2_cfrplus_tiny.psol` | 1 (street) | CFR+ | 1-combo turn tree, 4 iterations |
| `river_kind2_v2_cfrplus_tiny.psol` | 2 (legacy river) | CFR+ | 1-combo river tree, 3 iterations |

## Provenance

Generated with `generate_psol_fixtures` from this repository’s PSOL writer
(codec-compatible with the `v0.1.2` wire layout: streaming write, versions 1–3,
kinds 1–2). Source tip at generation time is recorded in git history for these
blobs.

Regenerate (does not rewrite committed expected values until you update tests):

```bash
cmake --build build --target generate_psol_fixtures
./build/generate_psol_fixtures tests/fixtures/psol
```

## Contract covered by tests

- Kind / algorithm / iteration counts
- Combo order (`oop_combos` / `ip_combos`) and `slot_actions` shape
- Continue-from-fixture matches uninterrupted training for the remaining iters
- Ordering of combos, slots, actions, runouts, and public paths is part of the
  on-disk contract; changing that order requires a layout id + remap or a hard
  compatibility error (not implemented yet — document-only until an ordering
  change ships)
