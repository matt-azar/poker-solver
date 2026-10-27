# Hold'em explorer

`explorer` is a local page for one flop, turn, or river. It is a separate program. The solvers do not include it, and the page does not implement CFR.

From the repository root:

```sh
explorer
```

Open `http://127.0.0.1:8765`. The server listens on `127.0.0.1` only. `--port` changes the port. Static files come from `ui/`.

The board length chooses where the hand starts. Three cards solve the flop, the turn, and the river in one tree: the turn and the river are dealt inside that tree, and each street is bet. Four cards solve the turn and the river the same way. Five cards are the river only, because the flop and the turn have already been dealt. Five cards use the river public tree. Three or four cards use the turn and flop public tree. Painting a range writes the same text the solver already parses: `AA`, `AKs`, `AKo:0.5`, `QQ+`, `22-77`, `ATs+`. A weight slider sets the next paint. Clicking a cell that already has that weight clears it. Dragging paints the chosen weight across cells. Cards on the board are grey and cannot be selected.

Empty per-street size boxes use the shared bet list. A geometric size, an all-in threshold, an accuracy stop, an OOP donk size, a pot cap, and a switch that removes the 3-bet are optional. Donk sizes are used when the previous street was bet by the in-position player. A pot cap of 1 cuts a larger size down to the pot. The 3-bet switch removes the re-raise after a bet and a raise. Fixed chip amounts and raise multiples such as `20c` and `3x` are set on the `street_solver` command line. Accuracy is a fraction of the pot and stops the run when the Nash gap is at most that fraction of the pot. The frozen combo pass is offered on a flop or a turn. A river stays on the exact public-tree update.

The page then shows:

- The street, pot, stack, board, out-of-position value, the Nash gap, and the gap as a fraction of the pot
- A Nash-gap chart across the samples taken during the run
- A 13×13 strategy matrix for each player, separate from the range grids. Color is the average open-bet frequency. A cell lists the suit combos and each action's probability, including mixes
- The betting line, chosen from the public history, with the strategy at that line
- Export writes the same JSON the page is showing

The default spot is aces versus kings on `Ah Kd 7c 4s 2h`. That is the same tree as `configs/river_default.json`, with 200 iterations instead of 500. A wide flop with several bet sizes can exceed the 200,000-terminal cap; the page shows that error instead of building the tree.
