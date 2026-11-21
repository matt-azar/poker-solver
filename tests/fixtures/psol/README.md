# PSOL fixtures

These two files are pre-v4 checkpoints. Open rejects them. They are not resumable saves.

| File | Decode error |
| --- | --- |
| `street_kind1_v2_cfrplus_tiny.psol` | `LegacyCheckpointRejected` |
| `river_kind2_v2_cfrplus_tiny.psol` | `Kind2RiverRejected` |

`formats/src/psol_v4.zig` reads version 4 only. A file version below 4 returns `LegacyCheckpointRejected`. If that old payload’s kind byte is 2, the error is `Kind2RiverRejected`. Session open of the street fixture returns `LegacyCheckpointRejected` and leaves the previous solution in place (`app/src/root.zig`).

The bytes are the pin. Do not rewrite them as v4. Current product saves are PSOL v4.
