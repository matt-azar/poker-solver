#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Repro diary helpers for Study crash/hang reports.

Creates / fills a short diary (what clicked, street/solve state, free-text)
that collect/send attach into the evidence zip and issue body.

Examples::

  python scripts/debug/repro_diary.py --new
  python scripts/debug/repro_diary.py --prompt --out diary.md
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import eprint, utc_now_iso, write_json  # noqa: E402

TEMPLATE = _HERE / "repro_diary_template.md"
DIARY_NAME = "repro-diary.md"
DIARY_JSON_NAME = "repro-diary.json"


def template_text() -> str:
    if TEMPLATE.is_file():
        return TEMPLATE.read_text(encoding="utf-8")
    return "# Study repro diary\n\n(template missing)\n"


def new_diary_path(dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / DIARY_NAME
    if not path.is_file():
        path.write_text(template_text(), encoding="utf-8")
    return path


def diary_from_fields(
    *,
    clicked: str = "",
    street_state: str = "",
    notes: str = "",
    symptom: str = "",
    build: str = "",
) -> str:
    stamp = utc_now_iso()
    return f"""# Study repro diary

| Field | Value |
| --- | --- |
| Date (UTC) | `{stamp}` |
| Build / version | {build or "_(unknown)_"} |
| Symptom | {symptom or "_(unspecified)_"} |

## What I clicked / did

{clicked.strip() or "_(not filled)_"}

## Street / solve state

{street_state.strip() or "_(not filled)_"}

## Free-text notes

{notes.strip() or "_(none)_"}
"""


def diary_json_from_fields(**kwargs: str) -> dict[str, Any]:
    return {
        "kind": "repro-diary",
        "timestamp": utc_now_iso(),
        "clicked": kwargs.get("clicked", ""),
        "streetState": kwargs.get("street_state", ""),
        "notes": kwargs.get("notes", ""),
        "symptom": kwargs.get("symptom", ""),
        "build": kwargs.get("build", ""),
    }


def prompt_diary(*, non_interactive_ok: bool = True) -> Optional[dict[str, str]]:
    """Prompt on a TTY; return field dict or None if skipped / non-TTY."""
    if not sys.stdin.isatty():
        if non_interactive_ok:
            return None
        raise RuntimeError("stdin is not a TTY; pass --diary FILE or --notes")
    eprint("Repro diary (Enter to skip a field; empty all = skip diary):")
    try:
        symptom = input("  Symptom (crash/hang/freeze/other): ").strip()
        clicked = input("  What you clicked / did: ").strip()
        street = input("  Street / solve state: ").strip()
        notes = input("  Free-text notes: ").strip()
        build = input("  Build / version (optional): ").strip()
    except EOFError:
        return None
    if not any((symptom, clicked, street, notes, build)):
        return None
    return {
        "symptom": symptom,
        "clicked": clicked,
        "street_state": street,
        "notes": notes,
        "build": build,
    }


def write_diary_pair(dest_dir: Path, fields: dict[str, str]) -> tuple[Path, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    md = dest_dir / DIARY_NAME
    js = dest_dir / DIARY_JSON_NAME
    md.write_text(diary_from_fields(**fields), encoding="utf-8")
    write_json(js, diary_json_from_fields(**fields))
    return md, js


def resolve_diary_file(path: Optional[Path]) -> Optional[Path]:
    if path is None:
        return None
    p = path.expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"diary file missing: {p}")
    return p


def copy_diary_into(bundle_dir: Path, diary_path: Path) -> Path:
    dest = bundle_dir / DIARY_NAME
    shutil.copy2(diary_path, dest)
    return dest


def format_diary_for_issue(diary_path: Optional[Path], fields: Optional[dict[str, str]] = None) -> str:
    if fields:
        return diary_from_fields(**fields)
    if diary_path and diary_path.is_file():
        text = diary_path.read_text(encoding="utf-8", errors="replace")
        return text.strip() or "_(empty diary file)_"
    return "_(no diary)_"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--new",
        action="store_true",
        help=f"Write a blank template to cwd/{DIARY_NAME} (or --out)",
    )
    ap.add_argument("--prompt", action="store_true", help="Interactive fill")
    ap.add_argument("--out", type=Path, help="Output markdown path")
    ap.add_argument("--json-out", type=Path, help="Also write JSON")
    ap.add_argument("--clicked", default="")
    ap.add_argument("--street-state", default="")
    ap.add_argument("--notes", default="")
    ap.add_argument("--symptom", default="")
    ap.add_argument("--build", default="")
    args = ap.parse_args(argv)

    fields: Optional[dict[str, str]] = None
    if args.prompt:
        fields = prompt_diary()
        if fields is None:
            eprint("diary skipped")
            return 0
    elif any((args.clicked, args.street_state, args.notes, args.symptom, args.build)):
        fields = {
            "clicked": args.clicked,
            "street_state": args.street_state,
            "notes": args.notes,
            "symptom": args.symptom,
            "build": args.build,
        }

    out = args.out
    if args.new and not fields:
        dest = out or (Path.cwd() / DIARY_NAME)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(template_text(), encoding="utf-8")
        print(dest)
        return 0

    if fields:
        dest = out or (Path.cwd() / DIARY_NAME)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(diary_from_fields(**fields), encoding="utf-8")
        print(dest)
        if args.json_out:
            write_json(args.json_out, diary_json_from_fields(**fields))
            eprint(f"wrote {args.json_out}")
        return 0

    # Default: print template path / copy instructions.
    print(TEMPLATE if TEMPLATE.is_file() else "(missing template)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
