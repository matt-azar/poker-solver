# Browser Study preview (recorded IPC)

Private UI review of the same React Study shell. Live solving stays on desktop
Tauri + `solver-engine`. This path reads recorded IPC.

## Run locally

```bash
cd desktop
npm run preview:scenario
# open http://127.0.0.1:5173/?preview=node-locking
```

Reviewer states (after the lock-frequency scenario works):

- `?preview=node-locking&state=pending-ev`
- `?preview=node-locking&state=dropped-connection`

Commit SHA is injected via `VITE_PREVIEW_COMMIT_SHA` (git HEAD / `GITHUB_SHA`).

## Mock IPC boundary

| File | Role |
| --- | --- |
| `src/engine/transport.ts` | `installFixtureIpcHandler` — `solverEngineRequest` serves recorded replies before Tauri invoke |
| `src/preview/scenarios/nodeLockingFixture.ts` | Scenario replies + **assertExpectedLockSubmission** before `resolve_locked` |
| `src/preview/previewMode.ts` | URL bootstrap, reviewer states, `window.__STUDY_PREVIEW_FIXTURE__` |
| `src/platform/engine.ts` | Browser `ensureEngine` installs fixture when `?preview=` is set |

`resolve_locked` refuses the recorded success body unless the last `put_lock`
matched expected **node id**, **scope**, and **Check frequency ≈ 0.80**.

## Playwright

```bash
cd desktop
npm run test:e2e:preview
```

Traces are retained on failure (`playwright.config.ts` → `trace: retain-on-failure`).
