# Study debug report receiver

Accepts crash/hang diagnostics POSTs from `send_report.py` / the mini-app.

**Windows default (no Cloudflare, no npm/wrangler):** run the local launcher so
reports save to disk automatically. GitHub Issue create is optional.

---

## No Cloudflare — Matt’s everyday path

From the repo clone (`C:\Users\matta\poker-solver`):

```powershell
.\scripts\debug\study-debug-local.cmd
```

Or:

```powershell
python scripts\debug\study_debug.py local-debug
```

What it does:

1. Starts `server.py --local-disk` on **`127.0.0.1:8787`** (loopback only)
2. Generates/persists a shared secret under
   `%LOCALAPPDATA%\Holdem Study\local-receiver-secret.txt`
3. Writes `%USERPROFILE%\.holdem-study\report-webhook.json` (URL + secret)
4. Sets `HOLDEM_STUDY_REPORT_WEBHOOK_URL` / `_SECRET` for child processes
5. Opens the study-debug mini-app + the reports folder

Keep that window open. Run the **installed** Study as usual. When you have a
zip (Help → **Copy diagnostics zip**, or `study-debug.cmd collect`):

- Mini-app → **Send report to GitHub** (posts to localhost; name is historical)
- or `.\scripts\debug\study-debug.cmd send --zip path\to\zip --yes`

Files appear under:

`%LOCALAPPDATA%\Holdem Study\debug-reports\<timestamp>_<title>\`

(each folder: diagnostics zip, `issue-body.md`, `meta.json`, optional analysis)

Optional GitHub from the local receiver:

```powershell
$env:HOLDEM_STUDY_GITHUB_TOKEN = "ghp_…"   # never commit
python scripts\debug\start_local_debug.py --github
```

This is **not** product HTTP IPC and does not talk to `solver-engine`.

---

## Cloudflare Worker (optional always-on)

Only if you want intake without keeping a local Python window open.

### 1. PAT for the *server* only

Classic `repo`, or fine-grained Issues + Contents on `matt-azar/poker-solver`.
Never put this PAT on the Windows machine for the local-disk path. Never commit it.

### 2. Deploy

```bash
cd scripts/debug/report-receiver
npx wrangler login
npx wrangler secret put REPORT_SHARED_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

### 3. Windows User env

```powershell
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_URL",
  "https://holdem-study-report-receiver.<you>.workers.dev/report",
  "User")
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET",
  "<same REPORT_SHARED_SECRET>",
  "User")
```

**Why not Cursor publish-app?** Fine for a demo UI; worse for a private intake
holding a GitHub PAT. Prefer this in-repo receiver / local launcher.

---

## Protocol

`POST /report` (`multipart/form-data`)

| Field | Required | Notes |
| --- | --- | --- |
| `zip` | yes | diagnostics zip file |
| `title` | yes | Issue title |
| `body` | yes | Markdown; may contain `(pending upload)` placeholder |
| `repo` | no | default `GITHUB_REPO` / `matt-azar/poker-solver` |
| `labels` | no | JSON array or comma list (default `bug`) |
| `attach` | no | `release` / `none` (local-disk ignores attach for storage) |
| `zip_name` | no | original filename |
| `analysis_json` | no | redacted analysis text |
| `dry_run` | no | `true` → validate; local-disk still saves when `LOCAL_DISK=1` |

Auth header (either):

- `Authorization: Bearer <REPORT_SHARED_SECRET>`
- `X-Holdem-Study-Report-Secret: <REPORT_SHARED_SECRET>`

Success JSON includes `ok`, and either `saved_dir` (local-disk) and/or
`issue_url` / `attachment_url` (GitHub).

---

## Manual server (same as launcher)

```bash
python3 scripts/debug/report-receiver/server.py --local-disk --host 127.0.0.1 --port 8787
```

Smoke without GitHub:

```bash
# Terminal A
python3 scripts/debug/report-receiver/server.py --local-disk

# Terminal B
export HOLDEM_STUDY_REPORT_WEBHOOK_URL=http://127.0.0.1:8787/report
export HOLDEM_STUDY_REPORT_WEBHOOK_SECRET="$(cat ~/.holdem-study/local-receiver-secret.txt 2>/dev/null || cat "$LOCALAPPDATA/Holdem Study/local-receiver-secret.txt")"
python3 scripts/debug/send_report.py --zip /path/to/diag.zip --yes
```
