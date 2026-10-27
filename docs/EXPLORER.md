# River explorer

`explorer` is a local page for one river. It is a separate program. `CfrTrainer` and `RiverBatchSolver` do not include it, and the page does not implement CFR.

From the repository root:

```sh
explorer
```

Open `http://127.0.0.1:8765`. The server listens on `127.0.0.1` only. `--port` changes the port. Static files come from `ui/`.

The form sets the board, both ranges, pot, stack, bet sizes, iteration count, and vanilla CFR or CFR+. Solve runs the public-tree river solver. Stop finishes the current sample and keeps the strategy gathered so far. The page then shows:

- Pot, stack, board, out-of-position value, and the Nash gap
- A Nash-gap chart across the samples taken during the run
- A 13×13 matrix for each player. Color is the average open-bet frequency. A cell lists the suit combos and each action's probability, including mixes
- The betting line, chosen from the public history, with the strategy at that line
- Export writes the same JSON the page is showing

The default form is aces versus kings on `Ah Kd 7c 4s 2h`. That is the same tree as `configs/river_default.json`, with 200 iterations instead of 500.
