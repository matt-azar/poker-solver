# River beta browser client (live solving)

Thin Study entry that talks to `services/river-beta/` over HTTPS/HTTP.
Each visitor gets an isolated Zig `solver-engine` session (typed IPC).

**Separate** from:

- Precomputed public demo: `?demo=…` / `npm run build:public-demo`
- Private QA preview: `?preview=node-locking` / `npm run preview:scenario`
- Windows desktop: Tauri inherited-pipe IPC (unchanged)

## Run locally

```bash
# terminal 1 — engine + service
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
python3 services/river-beta/run.py --host 127.0.0.1 --port 8787 -v

# terminal 2 — Study UI
cd desktop && npm run dev
# open http://127.0.0.1:5173/?river-beta=1
```

Optional: `VITE_RIVER_BETA_URL=http://127.0.0.1:8787` (default).

## Behavior

- Boots an isolated service session and auto-solves the default tiny river config.
- Banner shows published bounds summary, idle remaining, CPU / peak RSS,
  live iteration progress, Solve / Cancel / Re-solve locks.
- Detects reaped sessions (`no_session`) and offers **Reconnect** (fresh
  isolated sidecar + auto-solve). Service-down boots still mount the banner
  with Retry.
- Progress / results flow through the existing `EngineClient` IPC path.
- Public demo builds (`VITE_PUBLIC_DEMO`) never arm this entry.

## Out of scope

Turn and flop live solving — measure river-beta metrics first
(`services/river-beta/README.md`).
