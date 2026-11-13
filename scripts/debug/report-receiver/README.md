# Study debug report receiver

Small webhook that accepts crash/hang diagnostics from Windows and opens a
GitHub Issue + release-asset attachment using a **server-side** GitHub token.

Windows only needs:

- `HOLDEM_STUDY_REPORT_WEBHOOK_URL`
- `HOLDEM_STUDY_REPORT_WEBHOOK_SECRET` (shared secret — not a GitHub PAT)

No `gh auth` / `GH_TOKEN` on Matt’s PC.

**Why not Cursor publish-app?** A Worker (or this tiny Python server) is easier
to keep as a durable personal webhook with env secrets and no product coupling.
Publish-app would work for a demo UI, but is a worse fit for a private intake
endpoint that holds a GitHub PAT.

---

## Matt does this once (Cloudflare Worker — preferred)

### 1. Create a classic PAT (or fine-grained token) for the *server*

On github.com → Settings → Developer settings → Personal access tokens:

- Classic: scopes **`repo`** + ability to upload release assets (included in `repo`)
- Fine-grained (on `matt-azar/poker-solver`): **Issues** read/write, **Contents**
  read/write (for the rolling prerelease `study-debug-reports`)

Never put this PAT on the Windows machine. Never commit it.

### 2. Install Wrangler and deploy

```bash
cd scripts/debug/report-receiver
npm install -g wrangler   # or: npx wrangler
npx wrangler login

# Non-secret default repo (already in wrangler.toml):
#   GITHUB_REPO = "matt-azar/poker-solver"

# Secrets (prompts; values are not printed to git):
npx wrangler secret put REPORT_SHARED_SECRET   # long random string you invent
npx wrangler secret put GITHUB_TOKEN           # the PAT from step 1

npx wrangler deploy
```

Wrangler prints a URL like `https://holdem-study-report-receiver.<you>.workers.dev`.
The intake path is `/report` (also accepts `POST /`).

### 3. Windows client env (User or session)

```powershell
# Permanent (User) — restart terminals after setting:
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_URL",
  "https://holdem-study-report-receiver.<you>.workers.dev/report",
  "User")
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET",
  "<same REPORT_SHARED_SECRET>",
  "User")
```

Or for one session:

```powershell
$env:HOLDEM_STUDY_REPORT_WEBHOOK_URL = "https://….workers.dev/report"
$env:HOLDEM_STUDY_REPORT_WEBHOOK_SECRET = "<shared secret>"
```

Optional config file (URL only; keep the secret in env):

`%USERPROFILE%\.holdem-study\report-webhook.json`

```json
{ "webhook_url": "https://….workers.dev/report" }
```

### 4. Send a report

```powershell
.\scripts\debug\study-debug.cmd send --zip path\to\diagnostics.zip --yes
# or mini-app → "Send report to GitHub"
```

`send_report.py` prefers the webhook when the URL is set. Fall back to local
`gh` / `HOLDEM_STUDY_GITHUB_TOKEN` with `--local-gh` if needed.

### 5. Smoke without creating a live Issue

Worker accepts `dry_run=true` form field (client: `send --dry-run` against the
webhook still builds the body locally and can POST with dry_run when
`--webhook-dry-run` is used). Prefer the local Python receiver for offline smoke:

```bash
# Terminal A
REPORT_SHARED_SECRET=devsecret python3 scripts/debug/report-receiver/server.py --dry-run

# Terminal B
export HOLDEM_STUDY_REPORT_WEBHOOK_URL=http://127.0.0.1:8787/report
export HOLDEM_STUDY_REPORT_WEBHOOK_SECRET=devsecret
python3 scripts/debug/send_report.py --zip /path/to/diag.zip --yes
```

---

## Alternative: stdlib Python server (VPS / local)

```bash
export REPORT_SHARED_SECRET='…'
export GITHUB_TOKEN='ghp_…'          # server only
export GITHUB_REPO=matt-azar/poker-solver
python3 scripts/debug/report-receiver/server.py --host 0.0.0.0 --port 8787
```

Put it behind HTTPS (Caddy / nginx / Cloudflare Tunnel). Same client env vars.

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
| `attach` | no | `release` (default on server) or `none` |
| `zip_name` | no | original filename |
| `analysis_json` | no | redacted analysis text (informational) |
| `dry_run` | no | `true` → accept + validate; no GitHub calls |

Auth header (either):

- `Authorization: Bearer <REPORT_SHARED_SECRET>`
- `X-Holdem-Study-Report-Secret: <REPORT_SHARED_SECRET>`

Success JSON: `{ ok, issue_url, issue_number, attachment_url, … }`.

Zip storage on the server path uses the rolling prerelease tag
`study-debug-reports` (binary-safe). Local `gh gist create` remains available
on the `--local-gh` client path.
