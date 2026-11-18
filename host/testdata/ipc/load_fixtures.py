"""Tiny protocol-2 frame helpers for host/testdata/ipc fixtures.

Test / script use only — not imported by the solver-engine sidecar.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any

FIXTURE_ROOT = Path(__file__).resolve().parent
ASSUMED_CEILING_BYTES = int((FIXTURE_ROOT / "boundary" / "CEILING.txt").read_text().strip())


def pack_frame(payload: bytes | str) -> bytes:
    """Length-prefix a UTF-8 JSON payload (LE u32 + body)."""
    raw = payload.encode("utf-8") if isinstance(payload, str) else payload
    return struct.pack("<I", len(raw)) + raw


def read_frame(buf: bytes, offset: int = 0) -> tuple[bytes, int]:
    """Read one frame from buf[offset:]. Returns (payload, next_offset)."""
    if offset + 4 > len(buf):
        raise ValueError("truncated length prefix")
    (n,) = struct.unpack_from("<I", buf, offset)
    if n == 0 or n > ASSUMED_CEILING_BYTES:
        raise ValueError(f"invalid payload length {n} (ceiling={ASSUMED_CEILING_BYTES})")
    start = offset + 4
    end = start + n
    if end > len(buf):
        raise ValueError("truncated payload")
    return buf[start:end], end


def load_bytes(rel: str | Path) -> bytes:
    path = FIXTURE_ROOT / rel
    return path.read_bytes()


def load_json(rel: str | Path) -> Any:
    path = FIXTURE_ROOT / rel
    return json.loads(path.read_text(encoding="utf-8"))


def load_text(rel: str | Path) -> str:
    return (FIXTURE_ROOT / rel).read_text(encoding="utf-8")


def load_manifest() -> dict[str, Any]:
    return load_json("manifest.json")


def reassemble_chunks(case_dir: str | Path) -> bytes:
    """Concat chunk*.bin under a fragmentation case directory."""
    d = FIXTURE_ROOT / case_dir
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    return b"".join((d / name).read_bytes() for name in meta["chunk_files"])


def synthesize_padded_frame(
    payload_len: int,
    *,
    request_id: str = "r-boundary-synth",
    op: str = "ready",
) -> bytes:
    """Build a valid-looking request frame whose JSON payload is exactly payload_len.

    Pads ``body.pad`` with ASCII ``x``. Raises if the envelope skeleton alone
    exceeds ``payload_len``.
    """
    if payload_len <= 0:
        raise ValueError("payload_len must be positive")

    def build(pad_len: int) -> bytes:
        body = {"pad": "x" * pad_len}
        env = {
            "v": 2,
            "kind": "request",
            "request_id": request_id,
            "job_id": None,
            "op": op,
            "ok": True,
            "body": body,
        }
        return json.dumps(env, separators=(",", ":"), ensure_ascii=True).encode("utf-8")

    # Binary search pad length so final JSON byte length == payload_len.
    lo, hi = 0, payload_len
    best: bytes | None = None
    while lo <= hi:
        mid = (lo + hi) // 2
        raw = build(mid)
        if len(raw) == payload_len:
            best = raw
            break
        if len(raw) < payload_len:
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        # Adjust with a final exact pad if skeleton growth is monotonic.
        probe = build(max(hi, 0))
        deficit = payload_len - len(probe)
        if deficit < 0:
            raise ValueError(
                f"cannot synthesize payload_len={payload_len}: "
                f"minimum envelope is {len(build(0))} bytes"
            )
        best = build(max(hi, 0) + deficit)
        if len(best) != payload_len:
            # deficit path can overshoot when digits in pad length grow; fall back
            # to raw padding after a fixed prefix.
            prefix = (
                f'{{"v":2,"kind":"request","request_id":{json.dumps(request_id)},'
                f'"job_id":null,"op":{json.dumps(op)},"ok":true,"body":{{"pad":"'
            ).encode("utf-8")
            suffix = b'"}}'
            pad_need = payload_len - len(prefix) - len(suffix)
            if pad_need < 0:
                raise ValueError(f"payload_len {payload_len} too small for skeleton")
            best = prefix + (b"x" * pad_need) + suffix
            assert len(best) == payload_len
    return pack_frame(best)


def node_select_bodies() -> tuple[str, str]:
    """Return (compact, spaced) body JSON strings — same semantic node_id."""
    compact = load_text("node_select/compact.body.json").rstrip("\n")
    spaced = load_text("node_select/spaced.body.json").rstrip("\n")
    return compact, spaced


def expected_checkpoint_filename() -> str:
    return load_text("unicode_checkpoint/expected_filename.txt").rstrip("\n")


if __name__ == "__main__":
    # Self-check when run from repo root or this directory.
    compact, spaced = node_select_bodies()
    assert json.loads(compact) == json.loads(spaced) == {"node_id": "p1.t-1.r-1"}
    name = expected_checkpoint_filename()
    assert name == "Turn-\U0001f0a1.psol"
    raw_body = load_json("unicode_checkpoint/raw_utf8.body.json")
    surr_body = load_json("unicode_checkpoint/surrogate_pair.body.json")
    assert raw_body["path"] == surr_body["path"] == name

    complete = load_bytes("fragmentation/complete.request.frame")
    for case in (
        "fragmentation/split_mid_length_prefix",
        "fragmentation/split_after_length_prefix",
        "fragmentation/split_header_body_boundary",
        "fragmentation/split_mid_body",
        "fragmentation/split_three_chunks",
    ):
        assert reassemble_chunks(case) == complete, case

    payload, nxt = read_frame(complete)
    assert nxt == len(complete)
    assert json.loads(payload)["op"] == "ready"

    for defect in ("missing_op", "missing_ok", "missing_job_echo"):
        meta = load_json(f"malformed_reply/{defect}.meta.json")
        assert meta["reject"] is True

    frame = synthesize_padded_frame(4096)
    body, end = read_frame(frame)
    assert end == len(frame)
    assert len(body) == 4096

    over = load_bytes("boundary/length_prefix_over_ceiling.bin")
    try:
        read_frame(over + b"x")
        raise SystemExit("expected over-ceiling reject")
    except ValueError:
        pass

    print("load_fixtures self-check ok")
    print(f"ceiling={ASSUMED_CEILING_BYTES}")
    print(f"manifest cases={len(load_manifest()['cases'])}")
