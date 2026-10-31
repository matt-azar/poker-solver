# Desktop Study workstation

Architecture decision and capability map for the React study client (`desktop/`) that talks to the existing `explorer` HTTP API. Numerical kernels are unchanged.

## Architecture decision (2026-10-31)

| Choice | Decision |
| --- | --- |
| Web client | React 19 + TypeScript + Vite |
| State | Zustand for study/layout/theme; query identity in the engine client |
| Engine transport | Typed `EngineClient` over the existing localhost HTTP API |
| Desktop shell | Tauri 2 planned for a later slice; browser + Vite proxy first |
| Static serving | Prefer `desktop/dist` when present; fall back to legacy `ui/` |
| Legacy UI | Kept under `ui/` for regression and fallback |

Rationale: the repository already exposes a proven explorer process boundary. Replacing the page with a typed client preserves solve/browse/save contracts without inventing a parallel API. Tauri packaging can wrap the same client and sidecar once the Study workspace is solid.

## Development

```sh
# terminal 1 — engine (from repo root, after cmake build)
explorer --port 8765

# terminal 2 — Study client
cd desktop && npm install && npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:8765`. Production:

```sh
cd desktop && npm run build
explorer   # serves desktop/dist when present
```

## Capability map

| Backend operation | Endpoint | Legacy UI (`ui/`) | New Study UI destination | Limitations | Tests |
| --- | --- | --- | --- | --- | --- |
| Status | `GET /api/status` | Poll 250ms | Status bar + solve strip | Metrics null when unset | `test_explorer_http.cpp`, `test_session.cpp` |
| Solve | `POST /api/solve` | Setup form | Build workspace + Solve | 409 if running; empty≠absent bets | HTTP + session |
| Pause / Stop | `POST /api/pause`, `/stop` | Buttons | Solve controls | Chunk boundary before publish | session; HTTP stop |
| Continue | `POST …/continue` | Continue | Solve controls | Same solution id | HTTP |
| Browse node | `GET …/nodes/{id}` | Tree + matrix | Action history + matrix | One node at a time | HTTP |
| Action EV | `GET …/values` | Calculate EVs | Inspector / Analysis | Decision only; may 202 | value worker |
| Runouts | `GET …/runouts` | Compare runouts | Lower dock table | Chance / street only | engine; sparse HTTP |
| Equity | `GET …/equity` | Averages only | Range Explorer / chart | Check-down; work limit | equity tests |
| Categories | `GET …/categories` | Table | Range Explorer | Five-card made-hand only | hand categories |
| Locks | PUT/DELETE `…/locks` | Hand detail | Lock drawer (slice 4) | Selected-combo in legacy | HTTP + lock tests |
| Resolve locked | `POST …/resolve-locked` | Resolve + warm-start | Solver menu | New solution + baseline | HTTP |
| Compare | `GET /api/compare` | Note | Compare workspace | Decision node | HTTP |
| Save / Open | `POST …/save`, `/open` | File fields | File menu / Build | PSOL v2 + locks | checkpoint HTTP |
| Recent | `GET /api/recent-solutions` | Dropdown | File menu | Cap 10 | recent_files |
| Templates / ranges | `GET /api/templates`, `/ranges` | Dropdowns | Build + Library | Flat dirs | templates/range lib |
| Config parse | `POST /api/config` | Load config | Build | street/river text only | indirect |

## Numerical labels (do not relabel without math)

- Chip EV: root-centered, units `chips`
- Accuracy / Nash gap: NashConv (sum of BR gains); accuracy is NashConv/pot
- Equity: check-down, fraction of pot — not chip EV
- Zero probability on a lock is a constraint; unlock is separate

## Slice status

1. **Audit + contracts** — this document + `EngineClient`
2. **Study workspace** — tokens, adaptive layout, context/history, segmented strategy matrix, combo inspector, node navigation, solve controls against live API
3. Analysis dock + organized Build — in progress / follow-on
4. Locks + Compare polish — follow-on
5. Tauri shell + Windows installer — follow-on
6. Visual/a11y/perf acceptance — follow-on
