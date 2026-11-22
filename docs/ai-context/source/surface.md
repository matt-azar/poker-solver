## Product surface (mounted UI)

- Local postflop solver: React Study UI + Zig `solver-engine` typed IPC. OpenAI is optional; **Solve** is local.
- Workspaces (menu bar tabs): **Study**, **Build**, **Equity**, **Compare**, **Library**.
- Primary AI surface: floating **Study assistant** — menu bar **Assistant** toggle. Hideable, movable, resizable. Available on every workspace. Keyboard shortcuts stay on `?` (Help overlay).
- Help overlay (`?`) shows the diagnostics folder path and offers **Open diagnostics folder** / **Copy diagnostics zip** (desktop only). Before Solve/Continue, Study writes cheap `last-solve.json` + `host-resources.json` (`snapshotKind=pre-solve`). Every Solve failed / session-dead writes `last-fault.json` and refreshes host resources (`snapshotKind=fault`). Temporary UI unresponsiveness (status-poll timeout/slow/hung, main-thread stall) appends `ui-hang-events.json` even when the soft blip recovers. Folder: `%LOCALAPPDATA%\Holdem Study\diagnostics` (plus `engine.log` / `session-meta.json`).
- There is **no** separate Build-page Setup assistant and **no** Help-menu “Study assistant…” entry.

### Apply / write behavior

- A narrow field edit with no conflicts writes onto the live Build draft, then shows **Keep** and **Undo**.
- A broad setup (create, duplicate, range replacement, or many fields) stays unapplied until **Keep**. That pending row also shows **Undo** and **Open in Build**. A conflict adds **Keep anyway**. Draft-revision checks still reject stale applies.
- After a write, **Keep** clears the Undo entry and **Undo** reverts that assistant change. Both controls stay on the Study assistant window.
- Chat text after a write comes from an **application receipt** (before/after). Prefer describing what the receipt committed.
- Solve is never started by the assistant.

### Build workspace (mounted controls)

Visible on Build today:

- Board, pot, stack, max raises
- Betting tree: flop/turn/river OOP & IP **bets** and **raises**
- **Turn donk** and **River donk** size fields only (Build has no donk size control on the flop)
- **Save tree** / **Open tree** open a one-level in-app betting-tree catalogue (localStorage; save / open / rename / delete; no OS file dialog) for sizes, caps, and `tree_edits` (leaves board, ranges, and stop alone)
- Pot cap, merge threshold (%), All-in threshold (%)
- Stop: iterations, accuracy (% of pot; `0.5` = 0.5% pot), time limit (s)
- Ranges: paint grids, Catalogue (seat×action tree), range text, Swap / Undo / Redo / Clear
- **Preview tree** starts collapsed. Decision branches start collapsed. Line edits go to `tree_edits`.
- **Export job** / **Import job** read and write portable study-job JSON (`holdem-study-job/1`).
- **Open ranges in Equity** copies board + ranges into the Equity workspace

Not mounted as Build form controls (but still draft fields the assistant may write when asked):

- Solve rake `rakeRate` / `rakeCap` (no dedicated Build/Settings control — use `fieldEdits` only when the player explicitly wants engine solve-rake changes)
- Boolean donk copy-bets toggles (`donkFlop` / `donkTurn` / `donkRiver`) — prefer donk **size text** / tree edits; do not invent a flop donk size control on Build

### Settings (Solve section)

Settings opens from the menu-bar gear (aria-label **Settings**). **Algorithm** is a read-only CFR+ field. Opening Settings sets the draft algorithm to `cfr_plus`. Other fields: samples, threads, memory MiB, solution path, incentives, edge tags, ICM stacks/payouts, display prefs (**EV display** Local / **Global EV (root-centered)**, bet-size labels). Chrome is dark-only (no theme/light toggle). The host trains CFR+. PSOL saves store the CFR+ algorithm byte.

### Study / other

- Study: node navigation (board, line, action history) above the range matrix; permanent right rail with Actions and Hands; **Overlay → EV+Eq** among overlays; lower analysis dock (**Compare runouts**, **Equity**, **Categories**, **Value / Bluffs**). Equity is the histogram, band filter, and the OOP vs IP chart. There is no Runouts tab. Chrome is dark-only. Solve, Continue, Pause, and Stop are in the status bar (Iter, EV, Acc; More holds Time, ETA, Rate, Job, Mem). The context strip shows board, pot, stack / SPR, root, to act, line, Compare runouts on a turn or river decision, Save, and Open.
- **Compare runouts** ranks cards on the current betting line from a river (or other) decision — check the displayed seat before reading the numbers. The assistant can open this report with card filters and frequency ranking via `compare_runouts`; clicks and **Open in Study** use the same navigation as a manual report click and stay bound to the send-time solution/policy.
- **Value / Bluffs** lists betting candidates. Size toggles keep combos that use the selected size and show that size's frequency. Equity mode is **At this node** or **After call** (for each combo, equity on the Call child of that combo's highest-frequency enabled size). The table shows 50 rows and can load more. Assistant bluff candidates use node equity.
- The floating Study assistant binds evidence to the **send-time** Study decision (solution, published policy revision, node, selected hand). Strategy / bluff / hand tools reuse the analysis scheduler and do **not** change Study selection. `compare_runouts` is the exception that opens Compare runouts with filters. The assistant never starts Solve.
- Solve, Pause, Continue, and Stop are in the status bar and the Solve menu. Shortcuts: `S` solve, `X` stop, `C` continue, when connected and the draft is valid.
- File → Save / Open — in-app solutions catalogue with user folders (OS file picker is secondary Browse disk); Library lists recent solutions and templates.
- Locks: Tree → Node locking… . Strategy edits: separate drawer.
- Equity workspace: standalone 2–6 player calculator (no solution required).
