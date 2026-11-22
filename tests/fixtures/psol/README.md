# PSOL rejection fixtures

These files are pre-v4 checkpoints. `formats` decode and Session `open` reject them. They are not Continue pins.

| File | Open error |
| --- | --- |
| `street_kind1_v2_cfrplus_tiny.psol` | `LegacyCheckpointRejected` |
| `river_kind2_v2_cfrplus_tiny.psol` | `Kind2RiverRejected` |

The blobs match the old `v0.1.2` wire: versions 1–3, kinds 1–2. Current saves are PSOL v4 and store the CFR+ algorithm byte only. A failed open leaves the previous solution id in place.

Tests: `formats/src/psol_v4.zig` (`reject legacy street fixture`, `reject kind2 river fixture`) and `app/src/root.zig` (legacy open does not replace the loaded solution).
