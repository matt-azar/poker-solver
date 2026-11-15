# River beta — live browser solving (limited)

HTTPS-capable service that gives each visitor an **isolated** Zig
`solver-engine` session over **typed IPC** (protocol 2). River boards only.

This is **not** the precomputed public demo (`?demo=…` / `build:public-demo`)
and **not** the private QA preview (`?preview=…`). The thin browser client is
`desktop/src/river-beta/` (`?river-beta=1`). Windows desktop Study stays on
Tauri inherited-pipe IPC.

## Requirements

- Built sidecar: `zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2`
  → `zig-out/bin/solver-engine`
- Python 3.10+ (stdlib only)

## Run locally

```bash
# from repo root
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
python3 services/river-beta/run.py --host 127.0.0.1 --port 8787 -v
```

HTTPS (optional local certs):

```bash
python3 services/river-beta/run.py \
  --certfile /path/to/cert.pem \
  --keyfile /path/to/key.pem \
  --port 8787
```

Health: `GET http://127.0.0.1:8787/health`

### Minimal solve smoke (curl)

```bash
# 1) create isolated session (stores HttpOnly cookie; also returns session_id)
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X POST http://127.0.0.1:8787/v1/sessions | jq .

# 2) begin + solve default river config
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X POST http://127.0.0.1:8787/v1/sessions/me/solve \
  -H 'content-type: application/json' \
  -d '{"iterations":20,"time_limit":10}' | jq .

# 3) poll progress
curl -s -c /tmp/rb.ck -b /tmp/rb.ck http://127.0.0.1:8787/v1/sessions/me/status | jq .

# 4) browse root node via IPC proxy
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X POST http://127.0.0.1:8787/v1/sessions/me/ipc \
  -H 'content-type: application/json' \
  -d '{"op":"node","body":{"node_id":"p0.t-1.r-1"}}' | jq .

# 5) cancel (job-scoped) / destroy
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X POST http://127.0.0.1:8787/v1/sessions/me/cancel \
  -H 'content-type: application/json' -d '{}' | jq .
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X DELETE http://127.0.0.1:8787/v1/sessions/me | jq .
```

Header alternative to cookies: `X-River-Beta-Session: <session_id>`.

### Re-solve after locks

```bash
# put_lock via /v1/sessions/me/ipc, then:
curl -s -c /tmp/rb.ck -b /tmp/rb.ck -X POST http://127.0.0.1:8787/v1/sessions/me/resolve \
  -H 'content-type: application/json' \
  -d '{"iterations":20,"time_limit":10}' | jq .
```

## Bounds (defaults)

| Bound | Default | Env override |
| --- | --- | --- |
| Concurrent sessions | 4 | `RIVER_BETA_MAX_SESSIONS` |
| Session idle TTL | 300 s | `RIVER_BETA_SESSION_IDLE_SEC` |
| Memory per session | ≤256 MiB (default config 64) | `RIVER_BETA_MAX_MEMORY_MIB` |
| Iterations | ≤200 (default 50) | `RIVER_BETA_MAX_ITERATIONS` |
| Solve time_limit | ≤30 s (default 15) | `RIVER_BETA_MAX_TIME_LIMIT_SEC` |
| Train threads | 1 | `RIVER_BETA_MAX_THREADS` |
| Weighted combos / player | ≤24 | `RIVER_BETA_MAX_COMBOS` |
| River bet sizes | ≤2 | `RIVER_BETA_MAX_RIVER_BETS` |
| Max raises | ≤1 | `RIVER_BETA_MAX_RAISES` |
| plan_memory preflight | ≤48 MiB | `RIVER_BETA_MAX_PLAN_MEMORY_BYTES` |

River-only: board must be **5 cards**. Flop/turn bet keys and non-5-card
boards are rejected (`river_only`). Unlimited `time_limit` is refused.

See `GET /v1/bounds`.

## Metrics (measure before turn/flop)

Each session tracks:

- `cpu_user_sec` / `cpu_system_sec` (sidecar `/proc` on Linux)
- `peak_rss_bytes` / `last_rss_bytes`
- `solve_wall_sec` / `solve_count`

Returned on session info, status, and IPC responses under `metrics`.
Review these before expanding the beta to turn or flop.

## API surface

| Method | Path | Role |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/v1/bounds` | Published caps |
| GET | `/v1/default-config` | Tiny river street-config |
| POST | `/v1/sessions` | Create isolated session |
| GET | `/v1/sessions/me` | Session + metrics |
| DELETE | `/v1/sessions/me` | Tear down sidecar |
| POST | `/v1/sessions/me/solve` | `begin_config` + `solve` |
| POST | `/v1/sessions/me/cancel` | Job-scoped cancel |
| POST | `/v1/sessions/me/resolve` | `resolve_locked` re-solve |
| GET | `/v1/sessions/me/status` | Progress + metrics |
| POST | `/v1/sessions/me/ipc` | Allowed typed-IPC ops proxy |

## Out of scope

- **Turn / flop** live solving (board ≠ 5 cards)
- Precomputed public demo packs / deploy
- Private QA fixture failure simulation
- Windows Tauri product path changes
- HTTP `:8765` / `holdem-explorer` restoration

## Tests

```bash
python3 -m unittest discover -s services/river-beta/tests -v
```
