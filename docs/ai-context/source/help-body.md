## What this product is

- Everyday postflop study: Build a spot → Solve → browse strategy on Study → optional Equity / Compare / Library.
- Numerical kernels run locally via the Zig `solver-engine` typed IPC sidecar. Solving does not require OpenAI.

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
- **Accuracy**: Pio exploitability = average of BR gains (NashConv/2); Build stop target is percent of pot by default. NashConv (sum) remains available as a diagnostic.
- **Equity**: fraction of pot — **not** chip EV. Study shows equity to a tenth of a percent.
- Locks: 0% inside a row that sums to 1 is a constraint; unlock is DELETE; all-zero rows rejected.

## Short how-to workflows (exact UI labels)

| Player question | Minimum steps |
| --- | --- |
| “Why does folding show 0 EV?” | Local EV uses folding now as the zero point. Open the **Settings** gear → **EV display** → **Global EV (root-centered)** to show EV on the root basis. |
| “Where do I see hand EV and equity?” | In **Study**, open a decision, choose **Overlay → EV+Eq**, and select a hand for details. Study starts loading EV and equity automatically on decision nodes. If a number is pending, say so. |
| “Which river cards are best for IP on this line?” | Prefer `compare_runouts` when the player is already on that river decision: open **Compare runouts** with filters (suit, board-pair, action frequency). Check the seat and supported sizes; wrong seat/size → path hint or supported actions. Otherwise navigate them to the river decision and **Compare runouts**. |
| “What does Accuracy mean?” | Accuracy is the average of the two best-response gains, or NashConv divided by two. On Build, enter percent of pot — `0.5` means stop at 0.5% of pot (engine pot fraction 0.005). |
| “Why is equity higher than EV?” | Equity is a share of the pot. EV measures expected utility in the solve, with future actions and the displayed reference point. Explain the different units before comparing the hand's figures. |
| “Where can I compare river cards?” | From a river decision in **Study**, open **Compare runouts**, or ask the assistant to filter/rank runouts on the current line. |

## When analysis is unavailable

Give the applicable reason and one next action:

- Build draft only → Study evidence appears after solving or opening a solution.
- Deal / chance node → open a decision for action EV.
- Specific missing hand → select its matrix cell.
- Permanent analysis error → surface the tool's actual reason (work/memory limit, etc.).
- Product and general poker help still work without a published solution.

## Credentials / AI

- OpenAI required in the product UI for the Study assistant. Keys may live in Tauri app-config secrets or browser `localStorage` demos — never bundled.
- Distributed products should use a backend proxy.
