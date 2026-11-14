## Product surface (mounted UI)

- Local postflop solver: React Study UI + `explorer` engine. OpenAI is optional; **Solve** is local.
- Workspaces (menu bar tabs): **Study**, **Build**, **Equity**, **Compare**, **Library**.
- Primary AI surface: floating **Study assistant** — menu bar **Assistant** toggle. Hideable, movable, resizable. Available on every workspace. Keyboard shortcuts stay on `?` (Help overlay).
- Help overlay (`?`) shows the diagnostics folder path and offers **Open diagnostics folder** / **Copy diagnostics zip** (desktop only). Before Solve/Continue, Study writes cheap `last-solve.json` + `host-resources.json` (`snapshotKind=pre-solve`). Every Solve failed / session-dead writes `last-fault.json` and refreshes host resources (`snapshotKind=fault`). Temporary UI unresponsiveness (status-poll timeout/slow/hung, main-thread stall) appends `ui-hang-events.json` even when the soft blip recovers. Folder: `%LOCALAPPDATA%\Holdem Study\diagnostics` (plus `engine.log` / `session-meta.json`).
- There is **no** separate Build-page Setup assistant and **no** Help-menu “Study assistant…” entry.

### Apply / write behavior

- Successful setup proposals **auto-write** onto the live Build draft (ranges, board, bet sizes, pot/stack, stop criteria, `fieldEdits`).
- An **Apply to Build** / **Apply anyway** control appears only when auto-commit is blocked (conflicts / validation). Do not tell the player to click Apply after a normal successful write.
- Chat text after a write comes from an **application receipt** (before/after). Prefer describing what the receipt committed.
- The player can **Undo** the last assistant transaction in the assistant window. Solve is never started by the assistant.

### Build workspace (mounted controls)

Visible on Build today:

- Board, pot, stack, max raises
- Betting tree: flop/turn/river OOP & IP **bets** and **raises**
- **Turn donk** and **River donk** size fields only (Build has no donk size control on the flop)
- **Save tree** / **Open tree** open a one-level in-app betting-tree catalogue (localStorage; save / open / rename / delete; no OS file dialog) for sizes, caps, and `tree_edits` (leaves board, ranges, and stop alone)
- Pot cap, merge threshold (%), All-in threshold (%)
- Stop: iterations, accuracy (pot fraction), time limit (s)
- Ranges: paint grids, Catalogue (seat×action tree), range text, Swap / Undo / Redo / Clear
- Collapsible **Preview tree** (tree line edits → `tree_edits`)
- **Open ranges in Equity** copies board + ranges into the Equity workspace

Not mounted as Build form controls (but still draft fields the assistant may write when asked):

- Solve rake `rakeRate` / `rakeCap` (no dedicated Build/Settings control — use `fieldEdits` only when the player explicitly wants engine solve-rake changes)
- Boolean donk copy-bets toggles (`donkFlop` / `donkTurn` / `donkRiver`) — prefer donk **size text** / tree edits; do not invent a flop donk size control on Build

### Settings (Solve section)

Settings dialog (menu **Settings → Open settings…**): algorithm draft (`cfr_plus` | `cfr` | `dcfr`), samples, threads, memory MiB, solution path, incentives, edge tags, ICM stacks/payouts, display prefs (theme, **EV display** Local / **Global EV (root-centered)**, bet-size labels). The engine trains CFR+ for every algorithm draft value. PSOL saves store the CFR+ algorithm byte.

### Study / other

- Study: action history, range matrix (**Overlay → EV+Eq** among overlays), combo inspector, lower analysis dock (**Compare runouts**, equity hist, categories, **Value / Bluffs**).
- **Compare runouts** ranks cards on the current betting line from a river (or other) decision — check the displayed seat before reading the numbers. The assistant can open this report with card filters and frequency ranking via `compare_runouts`; clicks and **Open in Study** use the same navigation as a manual report click.
- **Value / Bluffs** lists betting candidates; equity mode includes node equity and **After call** (panel-only; assistant bluff candidates use node equity).
- The floating Study assistant reads the **current** Study decision (path, seat, strategy, selected hand) and lists Value / Bluffs-style **bluff candidates** for IP/OOP via bounded read-only tools. Those Q&A tools reuse the analysis scheduler and do **not** change Study selection. `compare_runouts` is the exception that opens Compare runouts with filters. The assistant never starts Solve.
- Solve / Pause / Continue / Stop from Solve menu or shortcuts (`S` solve when connected + draft valid).
- File → Save / Open — PSOL solutions; Library lists recent solutions and templates.
- Locks: Tree → Node locking… . Strategy edits: separate drawer.
- Equity workspace: standalone 2–6 player calculator (no solution required).
