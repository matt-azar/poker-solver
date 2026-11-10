## Product surface (mounted UI)

- Local postflop solver: React Study UI + `explorer` engine. OpenAI is optional; **Solve** is local.
- Workspaces (menu bar tabs): **Study**, **Build**, **Equity**, **Compare**, **Library**.
- Primary AI surface: floating **Study assistant** — menu bar **Assistant** toggle. Hideable, movable, resizable. Available on every workspace. Keyboard shortcuts stay on `?` (Help overlay).
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
- Pot cap, merge threshold (%), No 3-bet
- Stop: iterations, accuracy (pot fraction), time limit (s)
- Ranges: paint grids, Catalogue (seat×action tree), range text, Swap / Undo / Redo / Clear
- Collapsible **Preview tree** (tree line edits → `tree_edits`)
- **Open ranges in Equity** copies board + ranges into the Equity workspace

Not mounted as Build form controls (but still draft fields the assistant may write when asked):

- Solve rake `rakeRate` / `rakeCap` (no dedicated Build/Settings control — use `fieldEdits` only when the player explicitly wants engine solve-rake changes)
- Boolean donk copy-bets toggles (`donkFlop` / `donkTurn` / `donkRiver`) — prefer donk **size text** / tree edits; do not invent a flop donk size control on Build

### Settings (Solve section)

Settings dialog (menu **Settings → Open settings…**): algorithm (`cfr_plus` | `cfr` | `dcfr`), samples, threads, memory MiB, solution path, incentives, edge tags, ICM stacks/payouts, display prefs (theme, EV local/global, bet-size labels).

### Study / other

- Study: action history, range matrix, combo inspector, lower analysis dock (runouts, equity hist, categories, Value / Bluffs).
- The floating Study assistant can read the live Study node (path, seat, strategy, selected hand) and list Value / Bluffs-style bluff candidates for IP/OOP via bounded read-only tools; it may hop a couple of nodes and reuse the analysis scheduler, but it does not Solve.
- Solve / Pause / Continue / Stop from Solve menu or shortcuts (`S` solve when connected + draft valid).
- File → Save / Open — PSOL solutions; Library lists recent solutions and templates.
- Locks: Tree → Node locking… . Strategy edits: separate drawer.
- Equity workspace: standalone 2–6 player calculator (no solution required).
