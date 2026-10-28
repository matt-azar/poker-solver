# Hold'em explorer

`explorer` is a local page for one flop, turn, or river. It is a separate program. The solvers do not include it, and the page does not implement CFR.

From the repository root:

```sh
explorer
```

Open `http://127.0.0.1:8765`. The server listens on `127.0.0.1` only. `--port` changes the port. Static files come from `ui/`.

The board length chooses where the hand starts. Three cards solve the flop, the turn, and the river in one tree: the turn and the river are dealt inside that tree, and each street is bet. Four cards solve the turn and the river the same way. Five cards are the river only, because the flop and the turn have already been dealt. Five cards use the river public tree. Three or four cards use the turn and flop public tree. Painting a range writes the same text the solver already parses: `AA`, `AKs`, `AKo:0.5`, `QQ+`, `22-77`, `ATs+`. A weight slider sets the next paint. Clicking a cell that already has that weight clears it. Dragging paints the chosen weight across cells. Cards on the board are grey and cannot be selected.

Empty per-street size boxes use the shared bet list. A geometric size, an all-in threshold, an accuracy stop, an OOP donk size, a pot cap, and a switch that removes the 3-bet are optional. Donk sizes are used when the previous street was bet by the in-position player. A pot cap of 1 cuts a larger size down to the pot. The 3-bet switch removes the re-raise after a bet and a raise. Fixed chip amounts and raise multiples such as `20c` and `3x` are set on the `street_solver` command line. Accuracy is a fraction of the pot and stops the run when the Nash gap is at most that fraction of the pot. The frozen combo pass is offered on a flop or a turn. A river stays on the exact public-tree update.

A finished flop or turn stays on the server as one solution. Status polls report the job, the value, the Nash gap, and the engine heap. They do not include strategy rows. The page then asks for the root node, and each button asks for that child only. A new solve expires the previous solution id. A river still uses one explicit strategy export after the solve finishes. The ordinary export button writes the node currently on screen, or that river export.

A completed solve keeps one record: the configuration, the iterations that finished, the runtime, the out-of-position value, both best-response values, the Nash gap, the sample series, and the street memory report when the tree has one. Status and export are written from that record. A metric that was not computed is JSON null. A river export has no engine-heap report, so those fields are null. A node response names the solution id and the job id and stays limited to that node.

An absent `oop_bets` or `ip_bets` key still defaults to `0.5, 1`. A present empty array stays empty, so a check-only tree can be requested. All-in remains its own switch.

Solution ids are `sN` and job ids are `jN`. Parsing uses the whole token. An overflowing, truncated, signed, or otherwise malformed id is HTTP 400. A well-formed id that is not the current solution is HTTP 404. Leading zeros that denote the same number select that number; `s00` is solution 0, which is never a published id. Node components use the same complete parse. A node index below 0 or past the tree is an unknown node.

Stop and publication share one state machine. `POST /api/stop` accepts an optional `{"job_id":"jN"}`. Omitting it stops the current job. The result is `accepted`, `complete`, or `stale`. A stop accepted before publication finishes the in-flight numerical work, marks the job cancelled, and publishes no solution. A stop after publication leaves the completed result in place. A stop for an old job does not cancel the job that replaced it. A constructor failure, a thread-launch failure, or a publication failure ends in the failed state. A failed or cancelled job has no queryable solution. Replacing a solution waits until current readers finish, drops the old engine, and only then builds the next one.

The page then shows:

- The street, pot, stack, board, out-of-position value, the Nash gap, and the gap as a fraction of the pot
- A Nash-gap chart across the samples taken during the run
- A 13×13 strategy matrix for the player to act, separate from the range grids. Color is the reach-weighted bet or raise frequency. When the line has no reach, that frequency is undefined. A cell lists the suit combos and each action's probability
- Buttons for the legal actions, or for the next public card. Each button loads that node. A river still lists histories from its one export
- Export writes the node on screen, or the river export

The default spot is aces versus kings on `Ah Kd 7c 4s 2h`. That is the same tree as `configs/river_default.json`, with 200 iterations instead of 500. A flop or a turn sends `memory_mib` (default 1024) and `threads` (default 1). The memory field is the street solver's heap budget. Threads above 1 are the frozen pass only; a river or a non-frozen request with more than one thread is rejected before the solve starts. If the tree does not fit, the page keeps running and shows the budget error. The solve is not reported as finished. The 200,000-terminal limit belongs to the `StreetGame` reference enumerator, which this page does not use.
