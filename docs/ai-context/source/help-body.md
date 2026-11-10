## What this product is

- Everyday postflop study: Build a spot → Solve → browse strategy on Study → optional Equity / Compare / Library.
- Numerical kernels run locally via the `explorer` HTTP API. Solving does not require OpenAI.

## Core workflow

1. **Build** — board, OOP/IP ranges, stacks/pot, tree bet sizes / Preview tree line editor.
2. **Solve** (menu or `S`) — when the engine is connected and the draft is valid.
3. **Study** — action history, range matrix, combo inspector, lower analysis dock.
4. **Pause / Continue / Stop** — chunk-boundary pause; Continue resumes; Stop ends.
5. **File → Save / Open** — PSOL solutions; Library lists recent solutions and templates.
6. **Equity** — standalone equity calculator; Build can open current ranges there.

## Range catalogue (high level)

- Preferred grain: **seat×action** charts composed into OOP/IP for SRP/3BP.
- Build → **Catalogue** opens the seat×action tree (save/edit user ranges in localStorage).
- Synthetic fixtures are demos — not verified GTO.
- Wording: pot type required for create; `100NL` = rake structure; silence → **cEV** + **100bb**.

## Numerical labels (do not redefine)

- **Chip EV**: root-centered, chips.
- **Action EV**: local decision EV by default (Fold = 0); Global = root-centered (Settings).
- **Accuracy**: Pio exploitability = average of BR gains (NashConv/2); targets are Accuracy/pot by default. NashConv (sum) remains available as a diagnostic.
- **Equity**: fraction of pot — **not** chip EV. Study shows equity to a tenth of a percent.
- Locks: 0% inside a row that sums to 1 is a constraint; unlock is DELETE; all-zero rows rejected.

## Credentials / AI

- OpenAI required in the product UI for the Study assistant. Keys may live in Tauri app-config secrets or browser `localStorage` demos — never bundled.
- Distributed products should use a backend proxy.
