# Protocol-2 IPC fixtures (Nov 18 2026 audit §6)

Shared **valid and reject** frames for structural-JSON and frame-contract work.
Fixture-only: no production parser changes live in this tree.

Wire format: little-endian `u32` payload length + UTF-8 JSON envelope
(`host/src/ipc.zig`, protocol version **2**).

## Assumed payload ceiling

| Consumer (today) | Max payload |
| --- | ---: |
| Zig host input (`ipc.readFrame` / `main`) | **16 MiB** |
| Desktop Rust framing | **16 MiB** |
| CLI `holdem_study_cli` reader | 64 MiB |
| River-beta Python reader | 64 MiB |

**These fixtures assume a hard ceiling of `16 * 1024 * 1024` bytes**
(`boundary/CEILING.txt`). That ceiling is the protocol-2 limit on the Zig host
and the desktop Rust framer. The CLI and river-beta readers in the table above
still accept 64 MiB. Admission byte budgets in Rust remain a separate limit.

## Cases

### `node_select/` — identical child selection bodies

Semantic object: select Study node `p1.t-1.r-1`.

| File | Role |
| --- | --- |
| `compact.body.json` | `{"node_id":"p1.t-1.r-1"}` |
| `spaced.body.json` | `{"node_id": "p1.t-1.r-1"}` (space after `:`) |
| `compact.request.json` / `.frame` | Full `op=node` request, compact body |
| `spaced_body.request.json` / `.frame` | Same envelope shape; spaced body only |
| `spaced_envelope.request.json` / `.frame` | Python-default spaced envelope + body |

Contract: both encodings must select the **same child**, not fall back to root.

### `unicode_checkpoint/` — card-symbol filename

Expected filename (UTF-8): `Turn-🂡.psol` (`expected_filename.txt`).
Code point U+1F0A1; UTF-8 `f0 9f 82 a1`; JSON escapes `\uD83C\uDCA1`.

| File | Role |
| --- | --- |
| `raw_utf8.body.json` | `"path":"Turn-🂡.psol"` with raw UTF-8 |
| `surrogate_pair.body.json` | `"path":"Turn-\uD83C\uDCA1.psol"` |
| `surrogate_pair_spaced.body.json` | Same escapes with default JSON spacing |
| `*.request.json` / `.frame` | Full `op=save` requests |

Contract: either encoding must round-trip to the same on-disk name.

### `fragmentation/` — ordinary short-read delivery

| Path | Role |
| --- | --- |
| `complete.request.frame` | One valid `ready` frame (source of truth) |
| `split_mid_length_prefix/` | Cut after 2 length bytes |
| `split_after_length_prefix/` | Cut after full 4-byte length |
| `split_header_body_boundary/` | Cut early in payload |
| `split_mid_body/` | Mid-payload cut |
| `split_three_chunks/` | Mid-length + mid-body |
| `two_frames_back_to_back.bin` | Two frames in one buffer |

Each split dir has `chunk*.bin` + `meta.json`. Concatenation of chunks equals
`complete.request.frame`.

### `malformed_reply/` — final replies consumers must reject

Baseline request correlation: `request_id=r-job-1`, `op=status`, `job_id=job-42`.

| File | Defect |
| --- | --- |
| `valid_baseline.reply.*` | All required fields present (contrast) |
| `missing_op.reply.*` | No `op` |
| `missing_ok.reply.*` | No boolean `ok` |
| `missing_job_echo.reply.*` | No `job_id` while request carried one |

Each defect has a `.meta.json` with `reject: true`. Progress frames are out of
scope here (modelled separately from final replies).

### `boundary/` — sizes near the ceiling

| File | Role |
| --- | --- |
| `CEILING.txt` | Assumed max payload bytes (decimal) |
| `tiny_valid.request.frame` | Smoke-sized valid frame |
| `length_prefix_over_ceiling.bin` | `u32` = ceiling+1, no body |
| `length_prefix_zero.bin` | `u32` = 0 |
| `exactly_ceiling.meta.json` | Synthesize payload_len == ceiling |
| `just_under_ceiling.meta.json` | Synthesize ceiling−1 |
| `just_over_ceiling.meta.json` | Synthesize ceiling+1 (reject) |

Do **not** commit multi-MiB blobs. Use `load_fixtures.synthesize_padded_frame`.

## Loader helper

`load_fixtures.py` (this directory) packs/unpacks frames, lists the manifest,
and synthesizes padded near-ceiling payloads for tests. Import from repo-root
scripts or copy the helpers; it is not production code.

```python
from host.testdata.ipc.load_fixtures import pack_frame, read_frame, synthesize_padded_frame
```

When importing as a path module:

```python
import importlib.util
spec = importlib.util.spec_from_file_location(
    "ipc_fixtures", "host/testdata/ipc/load_fixtures.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
```

## Provenance

Pinned for the Nov 18 2026 IPC audit (section 6 / Single prompt §5) against
protocol 2 on `main`. Later structural-JSON and frame-contract PRs should reuse
these bytes rather than inventing parallel examples.
