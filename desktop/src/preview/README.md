# Browser Study preview (recorded IPC)

Private UI review of the same React Study shell. Live solving stays on desktop
Tauri + `solver-engine`. This path reads recorded IPC.

## Run locally

```bash
cd desktop
npm run preview:scenario
# Study / node locking:
#   open http://127.0.0.1:5173/?preview=node-locking
# Equity Calculator:
#   open http://127.0.0.1:5173/?preview=equity-calculator
```

Reviewer states (after the lock-frequency scenario works):

- `?preview=node-locking&state=pending-ev`
- `?preview=node-locking&state=dropped-connection`
- `?preview=equity-calculator&state=dropped-connection`

Commit SHA is injected via `VITE_PREVIEW_COMMIT_SHA` (git HEAD / `GITHUB_SHA`).

## Mock IPC boundary

| File | Role |
| --- | --- |
| `src/engine/transport.ts` | `installFixtureIpcHandler` — `solverEngineRequest` serves recorded replies before Tauri invoke |
| `src/preview/scenarios/nodeLockingFixture.ts` | Scenario replies + **assertExpectedLockSubmission** before `resolve_locked` |
| `src/preview/scenarios/equityJobFixture.ts` | Calculator jobs + **assertExpectedEquitySubmission** on `start_equity_job` |
| `src/preview/scenarios/equityCalculatorFixture.ts` | Equity-only scenario (idle Study status + calculator jobs) |
| `src/preview/previewMode.ts` | URL bootstrap, reviewer states, `window.__STUDY_PREVIEW_FIXTURE__` |
| `src/platform/engine.ts` | Browser `ensureEngine` installs fixture when `?preview=` is set |

`resolve_locked` refuses the recorded success body unless the last `put_lock`
matched expected **node id**, **scope**, and **Check frequency ≈ 0.80**.

`start_equity_job` refuses unless **method=exact**, **board=2c 3d 7h 9s Jc**, and
**players AsAd / KcKd** (same contract as `scripts/zig/equity-calculator-smoke.py`).
Public demo (`?demo=`) still returns `precomputed_readonly` for calculator jobs.

## Playwright

```bash
cd desktop
npm run test:e2e:preview
```

Traces are retained on failure (`playwright.config.ts` → `trace: retain-on-failure`).
