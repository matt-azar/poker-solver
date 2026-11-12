#!/usr/bin/env python3
"""Assert a Windows PE OptionalHeader.Subsystem value (ZR-97 / ZR-106).

Usage:
  python3 scripts/zig/check-pe-subsystem.py zig-out/bin/solver-engine.exe --expect 2
  # 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI, 3 = IMAGE_SUBSYSTEM_WINDOWS_CUI
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path


def pe_subsystem(path: Path) -> int:
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise SystemExit(f"{path}: not an MZ image")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew : e_lfanew + 4] != b"PE\0\0":
        raise SystemExit(f"{path}: missing PE signature")
    magic = struct.unpack_from("<H", data, e_lfanew + 24)[0]
    if magic not in (0x10B, 0x20B):
        raise SystemExit(f"{path}: unexpected optional-header magic {magic:#x}")
    # Subsystem is at offset 68 in both PE32 and PE32+ optional headers.
    return struct.unpack_from("<H", data, e_lfanew + 24 + 68)[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("exe", type=Path, help="Path to a PE executable")
    ap.add_argument(
        "--expect",
        type=int,
        required=True,
        help="Expected OptionalHeader.Subsystem (2=GUI, 3=CUI)",
    )
    args = ap.parse_args()
    if not args.exe.is_file():
        print(f"missing: {args.exe}", file=sys.stderr)
        return 1
    got = pe_subsystem(args.exe)
    names = {2: "WINDOWS_GUI", 3: "WINDOWS_CUI"}
    label = names.get(got, f"UNKNOWN({got})")
    if got != args.expect:
        print(
            f"FAIL {args.exe}: subsystem={got} ({label}); expected {args.expect}",
            file=sys.stderr,
        )
        return 1
    print(f"ok {args.exe}: subsystem={got} ({label})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
