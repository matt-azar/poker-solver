#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Stdlib HTTP receiver for Study crash/hang debug reports.

Same protocol as ``src/worker.js`` (Cloudflare Worker). Use this for:

  * **Local debug (preferred without Cloudflare):** ``--local-disk`` saves
    every POST under a reports folder; GitHub Issue upload is optional
    when ``GITHUB_TOKEN`` is set
  * Local smoke / dry-run without wrangler
  * A tiny VPS / container deploy if you prefer Python over Workers

Env (server)::

  REPORT_SHARED_SECRET   required (auto-generated in --local-disk if missing)
  LOCAL_DISK=1           save zip+body to disk; GitHub optional
  HOLDEM_STUDY_REPORT_SAVE_DIR  override reports directory
  GITHUB_TOKEN           optional in local-disk mode; required otherwise
  GITHUB_REPO            default matt-azar/poker-solver
  PORT                   default 8787
  DRY_RUN=1              accept POSTs; stash only; no GitHub

Examples::

  python3 scripts/debug/report-receiver/server.py --local-disk
  REPORT_SHARED_SECRET=devsecret DRY_RUN=1 \\
    python3 scripts/debug/report-receiver/server.py
  REPORT_SHARED_SECRET=… GITHUB_TOKEN=ghp_… \\
    python3 scripts/debug/report-receiver/server.py --host 127.0.0.1 --port 8787
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from email import message_from_bytes
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

ATTACHMENT_PLACEHOLDER = "(pending upload)"
RELEASE_TAG = "study-debug-reports"
MAX_ZIP_BYTES = 40 * 1024 * 1024
DEFAULT_REPO = "matt-azar/poker-solver"
USER_AGENT = "holdem-study-report-receiver-py"
DEFAULT_PORT = 8787


def _eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def _timing_safe_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def holdem_study_config_dir() -> Path:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or ""
        if local:
            return Path(local) / "Holdem Study"
    return Path.home() / ".holdem-study"


def default_save_dir() -> Path:
    env = os.environ.get("HOLDEM_STUDY_REPORT_SAVE_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    return holdem_study_config_dir() / "debug-reports"


def persistent_secret_path() -> Path:
    return holdem_study_config_dir() / "local-receiver-secret.txt"


def ensure_shared_secret(*, allow_generate: bool) -> str:
    existing = os.environ.get("REPORT_SHARED_SECRET", "").strip()
    if existing:
        return existing
    path = persistent_secret_path()
    if path.is_file():
        secret = path.read_text(encoding="utf-8").strip()
        if secret:
            os.environ["REPORT_SHARED_SECRET"] = secret
            return secret
    if not allow_generate:
        raise RuntimeError("REPORT_SHARED_SECRET not set")
    secret = hashlib.sha256(
        (f"holdem-study-local|{os.urandom(16).hex()}").encode("utf-8")
    ).hexdigest()[:40]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(secret + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    os.environ["REPORT_SHARED_SECRET"] = secret
    _eprint(f"note: wrote local shared secret to {path}")
    return secret


def save_report_to_disk(
    *,
    save_root: Path,
    title: str,
    body: str,
    zip_name: str,
    zip_bytes: bytes,
    analysis_json: str,
    meta: dict[str, Any],
) -> dict[str, str]:
    """Write one report folder; return paths."""
    import datetime as _dt

    stamp = _dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    safe_title = re.sub(r"[^\w.\-]+", "_", title)[:60].strip("_") or "report"
    folder = save_root / f"{stamp}_{safe_title}"
    folder.mkdir(parents=True, exist_ok=True)
    zip_path = folder / (Path(zip_name).name or "diagnostics.zip")
    zip_path.write_bytes(zip_bytes)
    body_path = folder / "issue-body.md"
    body_path.write_text(body, encoding="utf-8")
    meta_path = folder / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    analysis_path = ""
    if analysis_json.strip():
        ap = folder / "analysis-redacted.json"
        ap.write_text(analysis_json, encoding="utf-8")
        analysis_path = str(ap)
    return {
        "saved_dir": str(folder),
        "saved_zip": str(zip_path),
        "saved_body": str(body_path),
        "saved_meta": str(meta_path),
        "saved_analysis": analysis_path,
    }


def github_api(
    method: str,
    path: str,
    *,
    token: str,
    api: str,
    data: Optional[bytes] = None,
    content_type: Optional[str] = None,
    accept: str = "application/vnd.github+json",
) -> Any:
    url = api.rstrip("/") + path
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    }
    if content_type:
        headers["Content-Type"] = content_type
    if data is not None:
        headers["Content-Length"] = str(len(data))
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
            msg = parsed.get("message") or body
        except json.JSONDecodeError:
            msg = body
        raise RuntimeError(f"GitHub HTTP {exc.code}: {msg[:500]}") from exc


def ensure_prerelease(token: str, repo: str, api: str) -> dict[str, Any]:
    owner, name = repo.split("/", 1)
    try:
        rel = github_api(
            "GET",
            f"/repos/{owner}/{name}/releases/tags/{RELEASE_TAG}",
            token=token,
            api=api,
        )
        if isinstance(rel, dict):
            return rel
    except RuntimeError as exc:
        if "404" not in str(exc):
            raise
    created = github_api(
        "POST",
        f"/repos/{owner}/{name}/releases",
        token=token,
        api=api,
        content_type="application/json",
        data=json.dumps(
            {
                "tag_name": RELEASE_TAG,
                "name": "Study debug report uploads",
                "body": (
                    "Rolling prerelease for diagnostics zip attachments from the "
                    "study-debug report receiver. Not a product release."
                ),
                "prerelease": True,
                "draft": False,
            }
        ).encode("utf-8"),
    )
    if not isinstance(created, dict):
        raise RuntimeError("unexpected release create response")
    return created


def upload_release_asset(
    token: str,
    repo: str,
    api: str,
    asset_name: str,
    zip_bytes: bytes,
) -> str:
    release = ensure_prerelease(token, repo, api)
    upload_template = release.get("upload_url") or ""
    if not upload_template:
        raise RuntimeError("release missing upload_url")
    upload_url = re.sub(r"\{[^}]*\}", "", upload_template)
    upload_url += f"?name={urllib.parse.quote(asset_name)}"
    # uploads.github.com — use absolute URL from template, not api.github.com
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/zip",
        "Content-Length": str(len(zip_bytes)),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    }
    req = urllib.request.Request(
        upload_url, data=zip_bytes, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"asset upload HTTP {exc.code}: {body[:500]}") from exc
    owner, name = repo.split("/", 1)
    return str(
        data.get("browser_download_url")
        or f"https://github.com/{owner}/{name}/releases/download/{RELEASE_TAG}/{asset_name}"
    )


def create_issue(
    token: str,
    repo: str,
    api: str,
    *,
    title: str,
    body: str,
    labels: list[str],
) -> dict[str, Any]:
    owner, name = repo.split("/", 1)
    payload: dict[str, Any] = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    try:
        issue = github_api(
            "POST",
            f"/repos/{owner}/{name}/issues",
            token=token,
            api=api,
            content_type="application/json",
            data=json.dumps(payload).encode("utf-8"),
        )
    except RuntimeError as exc:
        if labels and "label" in str(exc).lower():
            payload.pop("labels", None)
            issue = github_api(
                "POST",
                f"/repos/{owner}/{name}/issues",
                token=token,
                api=api,
                content_type="application/json",
                data=json.dumps(payload).encode("utf-8"),
            )
        else:
            raise
    if not isinstance(issue, dict):
        raise RuntimeError("unexpected issue create response")
    return issue


def sanitize_asset_name(name: str) -> str:
    import datetime as _dt

    base = re.sub(r"[/\\]", "_", name or "diagnostics.zip")
    stamp = _dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    if not base.lower().endswith(".zip"):
        base = f"{base}.zip"
    return f"study-debug-{stamp}-{base}"


def parse_labels(raw: Optional[str]) -> list[str]:
    if not raw or not str(raw).strip():
        return ["bug"]
    s = str(raw).strip()
    try:
        parsed = json.loads(s)
        if isinstance(parsed, list):
            return [str(x) for x in parsed if str(x).strip()]
    except json.JSONDecodeError:
        pass
    return [p.strip() for p in s.split(",") if p.strip()]


def parse_multipart(content_type: str, body: bytes) -> dict[str, dict[str, Any]]:
    """Parse multipart/form-data into {name: {filename?, value: bytes|str}}."""
    # email parser needs a full MIME message header.
    raw = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        + body
    )
    msg = message_from_bytes(raw, policy=email_policy)
    fields: dict[str, dict[str, Any]] = {}
    if not msg.is_multipart():
        return fields
    for part in msg.iter_parts():
        disp = part.get_content_disposition()
        if disp != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename()
        payload = part.get_payload(decode=True)
        if payload is None:
            # get_content() for text parts
            try:
                text = part.get_content()
                payload = text.encode("utf-8") if isinstance(text, str) else b""
            except Exception:  # noqa: BLE001
                payload = b""
        entry: dict[str, Any] = {"value": payload}
        if filename:
            entry["filename"] = filename
        fields[str(name)] = entry
    return fields


class ReportHandler(BaseHTTPRequestHandler):
    server_version = "HoldemStudyReportReceiver/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        _eprint(f"[{self.log_date_time_string()}] {fmt % args}")

    def _send_json(self, obj: dict[str, Any], status: int = 200) -> None:
        raw = (json.dumps(obj, indent=2) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, X-Holdem-Study-Report-Secret",
        )
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            self._send_json(
                {
                    "ok": True,
                    "service": "holdem-study-report-receiver",
                    "local_disk": _env_truthy("LOCAL_DISK"),
                    "dry_run": _env_truthy("DRY_RUN"),
                    "github_token_configured": bool(
                        os.environ.get("GITHUB_TOKEN", "").strip()
                        or os.environ.get("HOLDEM_STUDY_GITHUB_TOKEN", "").strip()
                    ),
                    "save_dir": str(default_save_dir()),
                }
            )
            return
        self._send_json({"ok": False, "error": "not_found"}, 404)

    def _check_secret(self) -> Optional[str]:
        expected = os.environ.get("REPORT_SHARED_SECRET", "").strip()
        if not expected:
            return "server_misconfigured_shared_secret"
        header = (
            self.headers.get("X-Holdem-Study-Report-Secret")
            or self.headers.get("x-holdem-study-report-secret")
            or ""
        ).strip()
        auth = (self.headers.get("Authorization") or "").strip()
        bearer = ""
        m = re.match(r"^Bearer\s+(.+)$", auth, re.I)
        if m:
            bearer = m.group(1).strip()
        got = header or bearer
        if not got or not _timing_safe_eq(got, expected):
            return "unauthorized"
        return None

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/", "/report"):
            self._send_json({"ok": False, "error": "not_found"}, 404)
            return

        auth_err = self._check_secret()
        if auth_err:
            self._send_json({"ok": False, "error": auth_err}, 401)
            return

        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype.lower():
            self._send_json({"ok": False, "error": "expected_multipart"}, 400)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json({"ok": False, "error": "missing_content_length"}, 400)
            return
        # Cap whole request slightly above max zip (multipart overhead).
        if length > MAX_ZIP_BYTES + 2 * 1024 * 1024:
            self._send_json({"ok": False, "error": "request_too_large"}, 413)
            return
        try:
            raw_body = self.rfile.read(length)
            form = parse_multipart(ctype, raw_body)
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                {"ok": False, "error": "invalid_multipart", "detail": str(exc)}, 400
            )
            return

        zip_item = form.get("zip")
        if not zip_item or not isinstance(zip_item.get("value"), (bytes, bytearray)):
            self._send_json({"ok": False, "error": "missing_zip"}, 400)
            return
        zip_bytes = bytes(zip_item["value"])
        if not zip_bytes:
            self._send_json({"ok": False, "error": "empty_zip"}, 400)
            return
        if len(zip_bytes) > MAX_ZIP_BYTES:
            self._send_json(
                {
                    "ok": False,
                    "error": "zip_too_large",
                    "max_bytes": MAX_ZIP_BYTES,
                    "got_bytes": len(zip_bytes),
                },
                413,
            )
            return

        def field(name: str, default: str = "") -> str:
            item = form.get(name)
            if not item:
                return default
            val = item.get("value", b"")
            if isinstance(val, bytes):
                return val.decode("utf-8", errors="replace")
            return str(val if val is not None else default)

        title = field("title").strip() or "Study debug report"
        body = field("body")
        if not body.strip():
            self._send_json({"ok": False, "error": "missing_body"}, 400)
            return
        repo = field("repo").strip() or os.environ.get("GITHUB_REPO", DEFAULT_REPO).strip()
        attach = field("attach", "release").strip().lower() or "release"
        labels = parse_labels(field("labels"))
        zip_name = field("zip_name").strip() or str(
            zip_item.get("filename") or "diagnostics.zip"
        )
        analysis_json = field("analysis_json")
        dry_run = field("dry_run").lower() == "true" or _env_truthy("DRY_RUN")
        local_disk = _env_truthy("LOCAL_DISK")

        if dry_run and not local_disk:
            stash = Path(tempfile.gettempdir()) / "holdem-study-report-dry-run"
            stash.mkdir(parents=True, exist_ok=True)
            out = stash / Path(zip_name).name
            out.write_bytes(zip_bytes)
            self._send_json(
                {
                    "ok": True,
                    "dry_run": True,
                    "repo": repo,
                    "title": title,
                    "zip_name": zip_name,
                    "zip_bytes": len(zip_bytes),
                    "labels": labels,
                    "attach": attach,
                    "stashed_zip": str(out),
                    "issue_url": None,
                    "issue_number": None,
                    "attachment_url": None,
                }
            )
            return

        saved: dict[str, str] = {}
        if local_disk or dry_run:
            disk_body = body
            if ATTACHMENT_PLACEHOLDER in disk_body:
                disk_body = disk_body.replace(
                    ATTACHMENT_PLACEHOLDER,
                    "_(saved on local disk — see saved_zip)_",
                )
            try:
                saved = save_report_to_disk(
                    save_root=default_save_dir(),
                    title=title,
                    body=disk_body,
                    zip_name=zip_name,
                    zip_bytes=zip_bytes,
                    analysis_json=analysis_json,
                    meta={
                        "title": title,
                        "repo": repo,
                        "labels": labels,
                        "zip_name": zip_name,
                        "zip_bytes": len(zip_bytes),
                        "local_disk": True,
                        "dry_run": dry_run,
                    },
                )
                _eprint(f"saved report: {saved.get('saved_dir')}")
            except OSError as exc:
                self._send_json(
                    {"ok": False, "error": "save_failed", "detail": str(exc)}, 500
                )
                return

        token = os.environ.get("GITHUB_TOKEN", "").strip() or os.environ.get(
            "HOLDEM_STUDY_GITHUB_TOKEN", ""
        ).strip()

        # Local-disk primary path: GitHub is optional.
        if local_disk and (dry_run or not token):
            self._send_json(
                {
                    "ok": True,
                    "dry_run": bool(dry_run),
                    "local_disk": True,
                    "repo": repo,
                    "title": title,
                    "zip_name": zip_name,
                    "zip_bytes": len(zip_bytes),
                    "labels": labels,
                    "attach": "local-disk",
                    "issue_url": None,
                    "issue_number": None,
                    "attachment_url": None,
                    **saved,
                }
            )
            return

        if not token:
            self._send_json(
                {"ok": False, "error": "server_misconfigured_github_token"}, 500
            )
            return
        api = os.environ.get("GITHUB_API", "https://api.github.com").rstrip("/")

        try:
            attachment_url = ""
            attachment_line = "_Not uploaded (`attach=none`)._"
            if local_disk and saved.get("saved_zip"):
                attachment_line = f"Local disk: `{saved['saved_zip']}`"
            if attach == "none":
                pass
            elif attach in ("release", "gist", "default", ""):
                asset_name = sanitize_asset_name(zip_name)
                attachment_url = upload_release_asset(
                    token, repo, api, asset_name, zip_bytes
                )
                attachment_line = f"[release asset]({attachment_url})"
            else:
                self._send_json(
                    {"ok": False, "error": "unsupported_attach", "attach": attach},
                    400,
                )
                return

            if ATTACHMENT_PLACEHOLDER in body:
                body = body.replace(ATTACHMENT_PLACEHOLDER, attachment_line)
            else:
                body = f"{body}\n\n### Attachment\n\n{attachment_line}\n"
            if saved.get("saved_dir"):
                body += f"\n\n_Also saved locally: `{saved['saved_dir']}`_\n"

            issue = create_issue(
                token, repo, api, title=title, body=body, labels=labels
            )
            self._send_json(
                {
                    "ok": True,
                    "dry_run": False,
                    "local_disk": local_disk,
                    "repo": repo,
                    "title": title,
                    "issue_url": issue.get("html_url"),
                    "issue_number": issue.get("number"),
                    "attachment_url": attachment_url or None,
                    "attach": "release" if attachment_url else ("local-disk" if saved else "none"),
                    "zip_name": zip_name,
                    "zip_bytes": len(zip_bytes),
                    **saved,
                }
            )
        except RuntimeError as exc:
            # If we already saved locally, still report partial success.
            if saved:
                self._send_json(
                    {
                        "ok": True,
                        "partial": True,
                        "local_disk": True,
                        "error": "github_api_failed",
                        "detail": str(exc),
                        "repo": repo,
                        "title": title,
                        "issue_url": None,
                        "issue_number": None,
                        "attachment_url": None,
                        "attach": "local-disk",
                        "zip_name": zip_name,
                        "zip_bytes": len(zip_bytes),
                        **saved,
                    }
                )
                return
            self._send_json(
                {"ok": False, "error": "github_api_failed", "detail": str(exc)},
                502,
            )


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", str(DEFAULT_PORT))),
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Force DRY_RUN=1 (no GitHub calls)",
    )
    ap.add_argument(
        "--local-disk",
        action="store_true",
        help="Save reports to disk; GitHub Issue only if GITHUB_TOKEN is set",
    )
    ap.add_argument(
        "--save-dir",
        type=Path,
        default=None,
        help="Override HOLDEM_STUDY_REPORT_SAVE_DIR (local-disk reports root)",
    )
    args = ap.parse_args(argv)

    if args.dry_run:
        os.environ["DRY_RUN"] = "1"
    if args.local_disk:
        os.environ["LOCAL_DISK"] = "1"
    if args.save_dir is not None:
        os.environ["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(args.save_dir.expanduser())

    local_disk = _env_truthy("LOCAL_DISK")
    dry_run = _env_truthy("DRY_RUN")

    try:
        secret = ensure_shared_secret(allow_generate=local_disk or dry_run)
    except RuntimeError:
        _eprint("error: set REPORT_SHARED_SECRET (or pass --local-disk / --dry-run)")
        return 2
    # Keep secret available for launchers that read the env after start.
    os.environ["REPORT_SHARED_SECRET"] = secret

    if not local_disk and not dry_run and not (
        os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("HOLDEM_STUDY_GITHUB_TOKEN", "").strip()
    ):
        _eprint(
            "error: set GITHUB_TOKEN, or pass --local-disk (disk-only) / --dry-run"
        )
        return 2

    if local_disk:
        save_root = default_save_dir()
        save_root.mkdir(parents=True, exist_ok=True)
        _eprint(f"local-disk save dir: {save_root}")

    # Bind loopback by default — never expose intake without explicit host.
    host = args.host or "127.0.0.1"
    httpd = ThreadingHTTPServer((host, args.port), ReportHandler)
    _eprint(
        f"listening on http://{host}:{args.port}/report "
        f"(local_disk={local_disk} dry_run={dry_run} "
        f"github={'yes' if (os.environ.get('GITHUB_TOKEN') or os.environ.get('HOLDEM_STUDY_GITHUB_TOKEN')) else 'no'})"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _eprint("shutting down")
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
