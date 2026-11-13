#!/usr/bin/env python3
"""Fail if a solver-engine binary contains AVX-512 (EVEX 512-bit) code.

Shipping Study targets AVX2-era hosts (e.g. ma1pc i7-10510U). A ReleaseFast
build without `-Dcpu=x86_64_v2` on an AVX-512 CI/cloud host emits `vmovdqu64`
/ zmm and raises `0xC000001D` (STATUS_ILLEGAL_INSTRUCTION) on those laptops
(ZR-175 / #288).

Usage:
  python3 scripts/zig/check-no-avx512.py zig-out/bin/solver-engine.exe
  python3 scripts/zig/check-no-avx512.py zig-out/bin/solver-engine
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path


def pe_executable_sections(data: bytes) -> list[tuple[str, bytes, int]]:
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew : e_lfanew + 4] != b"PE\0\0":
        raise SystemExit("PE signature missing")
    nsec = struct.unpack_from("<H", data, e_lfanew + 6)[0]
    opt_size = struct.unpack_from("<H", data, e_lfanew + 20)[0]
    sec_off = e_lfanew + 24 + opt_size
    out: list[tuple[str, bytes, int]] = []
    for i in range(nsec):
        o = sec_off + i * 40
        name = data[o : o + 8].split(b"\0", 1)[0].decode("ascii", "replace")
        va = struct.unpack_from("<I", data, o + 12)[0]
        rawsize = struct.unpack_from("<I", data, o + 16)[0]
        rawptr = struct.unpack_from("<I", data, o + 20)[0]
        chars = struct.unpack_from("<I", data, o + 36)[0]
        if chars & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            out.append((name, data[rawptr : rawptr + rawsize], va))
    if not out:
        raise SystemExit("no executable PE sections")
    return out


def elf_executable_sections(data: bytes) -> list[tuple[str, bytes, int]]:
    if data[4] != 2:  # ELFCLASS64
        raise SystemExit("only ELF64 supported")
    little = data[5] == 1
    end = "<" if little else ">"
    e_shoff = struct.unpack_from(end + "Q", data, 40)[0]
    e_shentsize = struct.unpack_from(end + "H", data, 58)[0]
    e_shnum = struct.unpack_from(end + "H", data, 60)[0]
    e_shstrndx = struct.unpack_from(end + "H", data, 62)[0]
    # Section header: name offset at 0, type at 4, flags at 8, addr at 16, offset at 24, size at 32
    shstr_off = struct.unpack_from(
        end + "Q", data, e_shoff + e_shstrndx * e_shentsize + 24
    )[0]
    shstr_size = struct.unpack_from(
        end + "Q", data, e_shoff + e_shstrndx * e_shentsize + 32
    )[0]
    shstr = data[shstr_off : shstr_off + shstr_size]
    out: list[tuple[str, bytes, int]] = []
    for i in range(e_shnum):
        base = e_shoff + i * e_shentsize
        name_off = struct.unpack_from(end + "I", data, base)[0]
        sh_type = struct.unpack_from(end + "I", data, base + 4)[0]
        sh_flags = struct.unpack_from(end + "Q", data, base + 8)[0]
        sh_addr = struct.unpack_from(end + "Q", data, base + 16)[0]
        sh_offset = struct.unpack_from(end + "Q", data, base + 24)[0]
        sh_size = struct.unpack_from(end + "Q", data, base + 32)[0]
        # SHF_EXECINSTR = 0x4; SHT_PROGBITS = 1
        if sh_type != 1 or (sh_flags & 0x4) == 0:
            continue
        end_name = shstr.find(b"\0", name_off)
        name = shstr[name_off:end_name].decode("ascii", "replace")
        out.append((name, data[sh_offset : sh_offset + sh_size], sh_addr))
    if not out:
        raise SystemExit("no executable ELF sections")
    return out


def iter_text_blobs(data: bytes) -> list[tuple[str, bytes, int]]:
    if data[:2] == b"MZ":
        return pe_executable_sections(data)
    if data[:4] == b"\x7fELF":
        return elf_executable_sections(data)
    raise SystemExit("unsupported image (need PE or ELF)")


def is_plausible_evex(p0: int, p1: int) -> bool:
    """Filter ASCII / data false positives (Intel: P0 bits 3:2 must be 0)."""
    if (p0 & 0x0C) != 0:
        return False
    # Map select lives in low bits of P1 for common forms; 00 is not a real map.
    if (p1 & 0x03) == 0:
        return False
    return True


def count_avx512_movdqu(blob: bytes) -> tuple[int, list[tuple[int, str]]]:
    """Count EVEX 512-bit 6F/7F (vmovdqa/qu family) and sample a few offsets."""
    hits = 0
    samples: list[tuple[int, str]] = []
    i = 0
    n = len(blob)
    while i < n - 5:
        if blob[i] == 0x62:
            p0, p1, p2 = blob[i + 1], blob[i + 2], blob[i + 3]
            ll = (p2 >> 5) & 0b11
            opc = blob[i + 4]
            if (
                ll == 0b10
                and opc in (0x6F, 0x7F)
                and is_plausible_evex(p0, p1)
            ):
                hits += 1
                if len(samples) < 8:
                    samples.append((i, blob[i : i + 8].hex(" ")))
            i += 1
        else:
            i += 1
    return hits, samples


def count_zmm0_prefixes(blob: bytes) -> int:
    # Classic vmovdqu64 zmm0 forms seen from Zig ReleaseFast/native.
    return blob.count(bytes.fromhex("62f1fe48")) + blob.count(
        bytes.fromhex("62f1fd48")
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("binary", type=Path, help="solver-engine PE or ELF path")
    args = ap.parse_args()
    if not args.binary.is_file():
        print(f"missing: {args.binary}", file=sys.stderr)
        return 1
    data = args.binary.read_bytes()
    total = 0
    prefix_hits = 0
    samples: list[str] = []
    for label, blob, base in iter_text_blobs(data):
        hits, local = count_avx512_movdqu(blob)
        total += hits
        prefix_hits += count_zmm0_prefixes(blob)
        for off, hx in local:
            samples.append(f"{label}+{base + off:#x}: {hx}")
    if total or prefix_hits:
        print(
            f"FAIL {args.binary}: AVX-512 EVEX detected "
            f"(movdqu-family={total}, zmm0-prefix={prefix_hits}). "
            f"Rebuild with -Dcpu=x86_64_v2 (or omit -Dcpu after ZR-175 default).",
            file=sys.stderr,
        )
        for line in samples[:8]:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(f"ok {args.binary}: no AVX-512 EVEX movdqu/zmm0 prefixes in executable sections")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
