#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Send a Study crash/hang diagnostics report to the poker-solver GitHub repo.

Creates a structured GitHub Issue (preferred durable channel) and attaches the
diagnostics zip via a **secret gist** (default) or a prerelease asset — never
commits dumps into git history.

Auth (pick one; never commit tokens):

  1. ``gh auth login`` on this machine (preferred) — needs ``repo`` + ``gist``
  2. ``GH_TOKEN`` / ``GITHUB_TOKEN`` / ``HOLDEM_STUDY_GITHUB_TOKEN`` env var
     (classic PAT: ``repo`` + ``gist``; fine-grained: Issues write + Gists)

Examples::

  python scripts/debug/send_report.py --zip path\\to\\diagnostics.zip --dry-run
  python scripts/debug/send_report.py --zip path\\to\\diagnostics.zip
  python scripts/debug/send_report.py --collect   # collect then send
  python scripts/debug/study_debug.py send --zip path\\to\\zip

Optional: ``--dispatch`` fires ``repository_dispatch`` type
``study-debug-report`` so Actions can archive the zip as a workflow artifact.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional, Sequence
from urllib.parse import urlparse

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    ROOT,
    BundleMeta,
    diagnostics_dir,
    eprint,
    utc_now_iso,
    which,
    write_json,
)
from analyze_diagnostics import analyze_dir, _extract_zip  # noqa: E402

DEFAULT_REPO = "matt-azar/poker-solver"
DISPATCH_EVENT_TYPE = "study-debug-report"
RELEASE_TAG = "study-debug-reports"
SANITIZE_WARN = (
    "Diagnostics may contain absolute paths, Windows usernames, hostnames, "
    "and machine-local install dirs. Review before sharing publicly."
)


def _token_from_env() -> Optional[str]:
    for key in (
        "HOLDEM_STUDY_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
    ):
        val = os.environ.get(key, "").strip()
        if val:
            return val
    return None


def _gh_bin() -> Optional[str]:
    return which("gh")


def _run(
    cmd: Sequence[str],
    *,
    input_text: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return subprocess.run(
        list(cmd),
        input=input_text,
        text=True,
        capture_output=True,
        env=merged,
        check=check,
    )


def resolve_repo(explicit: Optional[str]) -> str:
    if explicit:
        return explicit.strip()
    env = os.environ.get("HOLDEM_STUDY_GITHUB_REPO", "").strip()
    if env:
        return env
    gh = _gh_bin()
    if gh:
        cp = _run([gh, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
        if cp.returncode == 0 and cp.stdout.strip():
            return cp.stdout.strip()
    # Fall back to origin remote parsing.
    cp = _run(["git", "-C", str(ROOT), "remote", "get-url", "origin"])
    if cp.returncode == 0:
        url = cp.stdout.strip()
        m = re.search(r"github\.com[:/]([^/]+/[^/.]+)", url)
        if m:
            return m.group(1).removesuffix(".git")
    return DEFAULT_REPO


def check_auth(*, prefer_gh: bool = True) -> dict[str, Any]:
    """Return auth status without creating anything."""
    token = _token_from_env()
    gh = _gh_bin()
    status: dict[str, Any] = {
        "gh_cli": gh,
        "token_env": bool(token),
        "token_env_names_set": [
            k
            for k in ("HOLDEM_STUDY_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")
            if os.environ.get(k, "").strip()
        ],
        "ok": False,
        "method": None,
        "detail": "",
    }
    if prefer_gh and gh:
        cp = _run([gh, "auth", "status"])
        # gh prints to stderr; treat exit 0 as logged in.
        raw = (cp.stderr or cp.stdout or "").strip()
        # Drop token fingerprint lines from stored detail.
        cleaned = "\n".join(
            ln for ln in raw.splitlines() if "token:" not in ln.lower()
        )
        status["detail"] = cleaned[:500]
        if cp.returncode == 0:
            status["ok"] = True
            status["method"] = "gh"
            return status
    if token:
        status["ok"] = True
        status["method"] = "env_token"
        status["detail"] = "Token present in environment (value not shown)."
        return status
    if gh:
        status["detail"] = (
            status.get("detail")
            or "gh found but not logged in. Run: gh auth login -s repo,gist"
        )
    else:
        status["detail"] = (
            "Neither gh auth nor HOLDEM_STUDY_GITHUB_TOKEN / GH_TOKEN available."
        )
    return status


def redact_sensitive(text: str) -> str:
    """Best-effort redaction of home/user path segments for issue bodies."""
    out = text
    home = str(Path.home())
    if home:
        out = out.replace(home, "<HOME>")
        # Also forward/backslash variants on Windows.
        out = out.replace(home.replace("\\", "/"), "<HOME>")
    local = os.environ.get("LOCALAPPDATA") or ""
    if local:
        out = out.replace(local, "<LOCALAPPDATA>")
        out = out.replace(local.replace("\\", "/"), "<LOCALAPPDATA>")
    user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    if user and len(user) >= 2:
        # Avoid eating short tokens; only replace path-like occurrences.
        out = re.sub(
            rf"(?i)([/\\])Users\1{re.escape(user)}\1",
            r"\1Users\1<USER>\1",
            out,
        )
        out = re.sub(
            rf"(?i)([/\\])home\1{re.escape(user)}\1",
            r"\1home\1<USER>\1",
            out,
        )
    host = platform.node()
    if host and len(host) >= 2:
        out = out.replace(host, "<HOST>")
    return out


def _zip_from_diagnostics_dir(diag: Path, dest_zip: Path) -> Path:
    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(diag.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=str(path.relative_to(diag)))
    return dest_zip


def resolve_zip(
    *,
    zip_path: Optional[Path],
    diagnostics: Optional[Path],
    collect: bool,
    work: Path,
) -> tuple[Path, Optional[dict[str, Any]]]:
    """Return (zip_path, optional collect meta)."""
    if collect:
        collect_script = _HERE / "collect_bundle.py"
        out_dir = work / "bundle"
        cmd = [
            sys.executable,
            str(collect_script),
            "--out",
            str(out_dir),
            "--zip",
            "--stacks",
        ]
        if diagnostics:
            cmd.extend(["--diagnostics-dir", str(diagnostics)])
        cp = _run(cmd)
        sys.stdout.write(cp.stdout)
        sys.stderr.write(cp.stderr)
        if cp.returncode != 0:
            raise RuntimeError(f"collect_bundle failed (exit {cp.returncode})")
        z = Path(str(out_dir) + ".zip")
        if not z.is_file():
            # collect may name zip as out.zip next to out dir
            candidates = list(work.glob("*.zip")) + list(out_dir.parent.glob("bundle*.zip"))
            if candidates:
                z = candidates[0]
            else:
                raise RuntimeError("collect_bundle did not produce a zip")
        return z, {"collected": True, "bundleDir": str(out_dir)}

    if zip_path:
        zp = zip_path.expanduser().resolve()
        if not zp.is_file():
            raise FileNotFoundError(f"missing zip: {zp}")
        return zp, None

    diag = diagnostics_dir(diagnostics)
    if not diag.is_dir():
        raise FileNotFoundError(
            f"diagnostics dir missing: {diag}. Pass --zip or --collect, "
            "or set HOLDEM_STUDY_DIAGNOSTICS_DIR."
        )
    z = work / "holdem-study-diagnostics.zip"
    _zip_from_diagnostics_dir(diag, z)
    return z, {"zippedFromDir": str(diag)}


def build_analysis(zip_path: Path, *, analysis_json: Optional[Path] = None) -> dict[str, Any]:
    if analysis_json and analysis_json.is_file():
        with analysis_json.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("kind") == "diagnostics-analysis":
            return data
    extracted = _extract_zip(zip_path)
    return analyze_dir(extracted)


def format_issue_body(
    analysis: dict[str, Any],
    *,
    zip_name: str,
    notes: str = "",
    attachment_line: str = "(pending upload)",
    extra_meta: Optional[dict[str, Any]] = None,
) -> str:
    c = analysis.get("classification") or {}
    primary = c.get("primary", "unknown")
    tags = ", ".join(c.get("tags") or []) or "(none)"
    evidence = c.get("evidence") or []
    interpretation = c.get("interpretation") or ""
    present = ", ".join(analysis.get("presentFiles") or []) or "(none)"
    engine_tail = analysis.get("engineLogTail") or []

    meta = BundleMeta()
    meta_bits = {
        "created_at": utc_now_iso(),
        "host_redacted": "<HOST>",
        "system": meta.system,
        "platform": redact_sensitive(meta.platform),
        "python": meta.python,
        "primary": primary,
    }
    if extra_meta:
        meta_bits.update(extra_meta)

    evidence_md = "\n".join(f"- {redact_sensitive(str(e))}" for e in evidence) or "- (none)"
    tail_md = "\n".join(
        f"| {redact_sensitive(str(ln))}" for ln in engine_tail[-20:]
    ) or "| (empty)"

    notes_block = redact_sensitive(notes.strip()) if notes.strip() else "_(none)_"

    body = f"""<!-- study-debug-report -->
## Study crash / hang debug report

> **Privacy:** {SANITIZE_WARN}

| Field | Value |
| --- | --- |
| Primary | `{primary}` |
| Tags | {tags} |
| Files present | {present} |
| Attachment | {attachment_line} |
| Zip name | `{zip_name}` |
| OS | `{meta.system}` / `{redact_sensitive(platform.platform())}` |
| Sent at (UTC) | `{meta_bits['created_at']}` |

### Interpretation

{redact_sensitive(str(interpretation))}

### Evidence

{evidence_md}

### Reporter notes

{notes_block}

### engine.log tail (redacted paths)

```
{tail_md}
```

### Analysis JSON (redacted paths)

```json
{redact_sensitive(json.dumps({
    "kind": analysis.get("kind"),
    "timestamp": analysis.get("timestamp"),
    "presentFiles": analysis.get("presentFiles"),
    "classification": c,
    "lastFault": analysis.get("lastFault"),
    "hostResources": analysis.get("hostResources"),
    "sessionMeta": analysis.get("sessionMeta"),
}, indent=2, sort_keys=True))}
```

---
_Sent by `scripts/debug/send_report.py` — do not commit dumps to `main`._
"""
    return body


def _gh_env() -> dict[str, str]:
    env: dict[str, str] = {}
    token = _token_from_env()
    if token:
        # gh prefers GH_TOKEN; do not print.
        env["GH_TOKEN"] = token
        env["GITHUB_TOKEN"] = token
    return env


def create_secret_gist(
    files: dict[str, Path],
    *,
    description: str,
    repo: str,
) -> str:
    """Upload files as a secret gist; return gist HTML URL."""
    gh = _gh_bin()
    if not gh:
        raise RuntimeError("gh CLI required for gist upload (install GitHub CLI)")
    cmd = [gh, "gist", "create", "--secret", "--desc", description]
    for path in files.values():
        cmd.append(str(path))
    cp = _run(cmd, env=_gh_env())
    if cp.returncode != 0:
        raise RuntimeError(
            f"gh gist create failed:\n{(cp.stderr or cp.stdout).strip()}"
        )
    url = (cp.stdout or "").strip().splitlines()[-1].strip()
    if not url.startswith("http"):
        raise RuntimeError(f"unexpected gist create output: {cp.stdout!r}")
    return url


def ensure_prerelease(repo: str) -> None:
    gh = _gh_bin()
    if not gh:
        raise RuntimeError("gh CLI required for release attach mode")
    # Check existing release.
    cp = _run(
        [gh, "release", "view", RELEASE_TAG, "--repo", repo],
        env=_gh_env(),
    )
    if cp.returncode == 0:
        return
    cp2 = _run(
        [
            gh,
            "release",
            "create",
            RELEASE_TAG,
            "--repo",
            repo,
            "--prerelease",
            "--title",
            "Study debug report uploads",
            "--notes",
            "Rolling prerelease for diagnostics zip attachments from "
            "`scripts/debug/send_report.py`. Not a product release. "
            "Assets are crash/hang evidence — treat as private.",
        ],
        env=_gh_env(),
    )
    if cp2.returncode != 0:
        raise RuntimeError(
            f"gh release create failed:\n{(cp2.stderr or cp2.stdout).strip()}"
        )


def upload_release_asset(repo: str, zip_path: Path, asset_name: str) -> str:
    ensure_prerelease(repo)
    gh = _gh_bin()
    assert gh
    # Avoid clobber: unique asset name.
    staged = zip_path.parent / asset_name
    if staged.resolve() != zip_path.resolve():
        shutil.copy2(zip_path, staged)
    cp = _run(
        [
            gh,
            "release",
            "upload",
            RELEASE_TAG,
            str(staged),
            "--repo",
            repo,
            "--clobber",
        ],
        env=_gh_env(),
    )
    if cp.returncode != 0:
        raise RuntimeError(
            f"gh release upload failed:\n{(cp.stderr or cp.stdout).strip()}"
        )
    # Construct download URL (works for private repos when authenticated).
    return f"https://github.com/{repo}/releases/download/{RELEASE_TAG}/{asset_name}"


def create_issue(
    repo: str,
    *,
    title: str,
    body: str,
    labels: Sequence[str],
) -> dict[str, Any]:
    gh = _gh_bin()
    if not gh:
        raise RuntimeError("gh CLI required to create issues")
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        suffix="-issue-body.md",
        delete=False,
    ) as tf:
        tf.write(body)
        body_path = tf.name
    try:
        cmd = [
            gh,
            "issue",
            "create",
            "--repo",
            repo,
            "--title",
            title,
            "--body-file",
            body_path,
        ]
        for lab in labels:
            cmd.extend(["--label", lab])
        cp = _run(cmd, env=_gh_env())
        if cp.returncode != 0:
            # Retry without labels if label missing.
            err = (cp.stderr or cp.stdout).strip()
            if "label" in err.lower() and labels:
                eprint(f"note: label create failed ({err}); retrying without labels")
                cmd2 = [
                    gh,
                    "issue",
                    "create",
                    "--repo",
                    repo,
                    "--title",
                    title,
                    "--body-file",
                    body_path,
                ]
                cp = _run(cmd2, env=_gh_env())
            if cp.returncode != 0:
                raise RuntimeError(
                    f"gh issue create failed:\n{(cp.stderr or cp.stdout).strip()}"
                )
        url = (cp.stdout or "").strip().splitlines()[-1].strip()
        num_m = re.search(r"/issues/(\d+)", url)
        return {"url": url, "number": int(num_m.group(1)) if num_m else None}
    finally:
        try:
            os.unlink(body_path)
        except OSError:
            pass


def comment_on_issue(repo: str, number: int, body: str) -> None:
    gh = _gh_bin()
    if not gh:
        return
    cp = _run(
        [gh, "issue", "comment", str(number), "--repo", repo, "--body", body],
        env=_gh_env(),
    )
    if cp.returncode != 0:
        eprint(f"warning: could not comment on issue: {(cp.stderr or cp.stdout).strip()}")


def fire_repository_dispatch(
    repo: str,
    *,
    issue_number: Optional[int],
    issue_url: str,
    artifact_url: str,
    primary: str,
) -> None:
    gh = _gh_bin()
    if not gh:
        raise RuntimeError("gh CLI required for --dispatch")
    owner, name = repo.split("/", 1)
    payload = {
        "event_type": DISPATCH_EVENT_TYPE,
        "client_payload": {
            "issue_number": issue_number,
            "issue_url": issue_url,
            "artifact_url": artifact_url,
            "primary": primary,
            "sent_at": utc_now_iso(),
        },
    }
    cp = _run(
        [
            gh,
            "api",
            f"repos/{owner}/{name}/dispatches",
            "--method",
            "POST",
            "--input",
            "-",
        ],
        input_text=json.dumps(payload),
        env=_gh_env(),
    )
    # GitHub returns 204 No Content on success (gh may show empty).
    if cp.returncode != 0:
        raise RuntimeError(
            f"repository_dispatch failed:\n{(cp.stderr or cp.stdout).strip()}"
        )


def default_title(analysis: dict[str, Any]) -> str:
    primary = (analysis.get("classification") or {}).get("primary") or "unknown"
    stamp = utc_now_iso().replace(":", "").replace("-", "")[:15]
    return f"Study debug report: {primary} ({stamp}Z)"


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--zip", type=Path, help="Diagnostics or collect-bundle zip")
    ap.add_argument(
        "--dir",
        type=Path,
        help="Diagnostics directory (zipped for upload if --zip omitted)",
    )
    ap.add_argument(
        "--collect",
        action="store_true",
        help="Run collect_bundle.py --zip --stacks first, then send that zip",
    )
    ap.add_argument(
        "--analysis",
        type=Path,
        help="Existing analyze_diagnostics JSON (otherwise analyze the zip)",
    )
    ap.add_argument("--title", help="Issue title (default derived from classification)")
    ap.add_argument("--notes", default="", help="Extra reporter notes for the issue body")
    ap.add_argument(
        "--repo",
        default=None,
        help=f"owner/name (default: git remote or {DEFAULT_REPO})",
    )
    ap.add_argument(
        "--label",
        action="append",
        default=None,
        help="Issue label (repeatable). Default: bug",
    )
    ap.add_argument(
        "--attach",
        choices=("gist", "release", "none"),
        default="gist",
        help="How to attach the zip (default: secret gist)",
    )
    ap.add_argument(
        "--dispatch",
        action="store_true",
        help=f"Also fire repository_dispatch '{DISPATCH_EVENT_TYPE}' for Actions archive",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Build title/body locally; do not call GitHub",
    )
    ap.add_argument(
        "--auth-check",
        action="store_true",
        help="Print auth status and exit (no upload)",
    )
    ap.add_argument(
        "--out-body",
        type=Path,
        help="Write issue markdown body to this path (also used with --dry-run)",
    )
    ap.add_argument(
        "--json-out",
        type=Path,
        help="Write send result JSON (dry-run or live)",
    )
    ap.add_argument(
        "--yes",
        action="store_true",
        help="Skip interactive confirm (still prints privacy warning)",
    )
    args = ap.parse_args(list(argv) if argv is not None else None)

    if args.auth_check:
        status = check_auth()
        print(json.dumps(status, indent=2))
        return 0 if status.get("ok") else 1

    repo = resolve_repo(args.repo)
    labels = list(args.label) if args.label else ["bug"]

    eprint(f"privacy: {SANITIZE_WARN}")
    eprint(f"target repo: {repo}")

    if not args.dry_run:
        auth = check_auth()
        if not auth.get("ok"):
            eprint("error: not authenticated for GitHub.")
            eprint("  Preferred:  gh auth login -s repo,gist")
            eprint(
                "  Or set:     HOLDEM_STUDY_GITHUB_TOKEN / GH_TOKEN "
                "(repo + gist scopes; never commit the token)"
            )
            eprint(f"  Detail: {auth.get('detail')}")
            return 2
        eprint(f"auth: ok via {auth.get('method')}")

    with tempfile.TemporaryDirectory(prefix="study-debug-send-") as tmp:
        work = Path(tmp)
        try:
            zip_path, collect_meta = resolve_zip(
                zip_path=args.zip,
                diagnostics=args.dir,
                collect=args.collect,
                work=work,
            )
        except (OSError, RuntimeError, FileNotFoundError) as exc:
            eprint(f"error: {exc}")
            return 1

        try:
            analysis = build_analysis(zip_path, analysis_json=args.analysis)
        except (OSError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
            eprint(f"error analyzing zip: {exc}")
            return 1

        title = args.title or default_title(analysis)
        zip_name = zip_path.name
        size_kib = zip_path.stat().st_size / 1024.0
        eprint(f"zip: {zip_path} ({size_kib:.1f} KiB)")
        eprint(f"primary: {(analysis.get('classification') or {}).get('primary')}")

        attachment_line = "(dry-run — not uploaded)"
        attachment_url = ""
        issue: dict[str, Any] = {}

        # Stage files for gist: redacted analysis + original zip.
        analysis_path = work / "analysis.json"
        analysis_path.write_text(
            redact_sensitive(json.dumps(analysis, indent=2, sort_keys=True)) + "\n",
            encoding="utf-8",
        )

        body_preview = format_issue_body(
            analysis,
            zip_name=zip_name,
            notes=args.notes,
            attachment_line=attachment_line,
            extra_meta=collect_meta,
        )
        if args.out_body:
            args.out_body.parent.mkdir(parents=True, exist_ok=True)
            args.out_body.write_text(body_preview, encoding="utf-8")
            eprint(f"wrote body: {args.out_body}")

        if args.dry_run:
            result = {
                "ok": True,
                "dry_run": True,
                "repo": repo,
                "title": title,
                "zip": str(zip_path),
                "zip_bytes": zip_path.stat().st_size,
                "primary": (analysis.get("classification") or {}).get("primary"),
                "attach": args.attach,
                "labels": labels,
                "body_preview_chars": len(body_preview),
                "auth": check_auth(),
            }
            if args.json_out:
                write_json(args.json_out, result)
            print(json.dumps(result, indent=2))
            print("\n--- issue title ---")
            print(title)
            print("\n--- issue body (preview) ---")
            print(body_preview[:4000])
            if len(body_preview) > 4000:
                print(f"\n… ({len(body_preview) - 4000} more chars)")
            return 0

        if not args.yes and sys.stdin.isatty():
            eprint(
                "About to create a GitHub Issue and upload the zip "
                f"via attach={args.attach}."
            )
            try:
                ans = input("Continue? [y/N] ").strip().lower()
            except EOFError:
                ans = "n"
            if ans not in ("y", "yes"):
                eprint("aborted")
                return 130

        try:
            if args.attach == "gist":
                # Unique names inside the gist.
                staged_zip = work / f"diagnostics-{utc_now_iso().replace(':', '')}.zip"
                shutil.copy2(zip_path, staged_zip)
                staged_analysis = work / "analysis-redacted.json"
                shutil.copy2(analysis_path, staged_analysis)
                attachment_url = create_secret_gist(
                    {
                        "zip": staged_zip,
                        "analysis": staged_analysis,
                    },
                    description=f"Study debug report for {repo}: {title[:80]}",
                    repo=repo,
                )
                attachment_line = f"[secret gist]({attachment_url})"
            elif args.attach == "release":
                stamp = utc_now_iso().replace(":", "").replace("-", "")
                asset_name = f"study-debug-{stamp}.zip"
                attachment_url = upload_release_asset(repo, zip_path, asset_name)
                attachment_line = f"[release asset]({attachment_url})"
            else:
                attachment_line = (
                    f"_Not uploaded (`--attach none`). Local zip: `{zip_name}` "
                    f"({size_kib:.1f} KiB) — attach manually in the GitHub UI._"
                )

            body = format_issue_body(
                analysis,
                zip_name=zip_name,
                notes=args.notes,
                attachment_line=attachment_line,
                extra_meta=collect_meta,
            )
            if args.out_body:
                args.out_body.write_text(body, encoding="utf-8")

            issue = create_issue(repo, title=title, body=body, labels=labels)
            if attachment_url and issue.get("number"):
                comment_on_issue(
                    repo,
                    int(issue["number"]),
                    f"Attachment mirror: {attachment_url}\n\n"
                    f"Zip: `{zip_name}` ({size_kib:.1f} KiB).",
                )

            if args.dispatch:
                if not attachment_url:
                    eprint("warning: --dispatch skipped (no attachment URL)")
                else:
                    # Validate URL looks like https before dispatching.
                    parsed = urlparse(attachment_url)
                    if parsed.scheme != "https":
                        raise RuntimeError("artifact URL must be https for dispatch")
                    fire_repository_dispatch(
                        repo,
                        issue_number=issue.get("number"),
                        issue_url=str(issue.get("url") or ""),
                        artifact_url=attachment_url,
                        primary=str(
                            (analysis.get("classification") or {}).get("primary")
                        ),
                    )
                    eprint(f"dispatched: {DISPATCH_EVENT_TYPE}")

        except RuntimeError as exc:
            eprint(f"error: {exc}")
            return 1

    result = {
        "ok": True,
        "dry_run": False,
        "repo": repo,
        "title": title,
        "issue_url": issue.get("url"),
        "issue_number": issue.get("number"),
        "attachment_url": attachment_url or None,
        "attach": args.attach,
        "primary": (analysis.get("classification") or {}).get("primary"),
        "dispatched": bool(args.dispatch and attachment_url),
    }
    if args.json_out:
        write_json(args.json_out, result)
    print(json.dumps(result, indent=2))
    if issue.get("url"):
        print(f"\nIssue: {issue['url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
