# Turn and flop

`StreetGame` is a heads-up no-limit tree on a 4-card turn or a 3-card flop. `StreetBatchSolver` stores that betting structure once and reuses it on every runout. It applies the same CFR and CFR+ update as `CfrTrainer<StreetGame>`, in the same deal order and the same runout order. `street_solver` uses the public tree unless `--reference` is set. `--frozen` holds the strategy fixed for one pass and updates every combo together. Each action is still explored with probability at least 0.05 / (number of actions), so a line the strategy has left keeps being updated. That pass is not the per-deal update, so a short run will not reproduce `--reference` action by action. It is checked by the value and the Nash gap. `RiverGame` is still the one-street river. There is no hand bucketing and no RNG.

Chance deals an ordered hand pair from the joint distribution on the starting board, then the players bet. When the street ends without a fold, the next card is dealt uniformly from the cards that are not on the board and not in either hand. A turn tree deals the river. A flop tree deals the turn and then the river. A fold ends the hand. Chips already invested stay in the pot, and the next street starts with no bet to call.

Player 0 is out of position and acts first on every street. Utilities use the same net-chip rule as the river: `pot / 2` is the dead money each player already posted, and investments on these streets are added on top. Uncalled chips are not extra profit.

An information set is the acting player's own hand, the cards already dealt, and the public action line. It does not contain the opponent's hand. A turn decision is one node, shared by every river that can follow it.

The betting lines are the same on every turn card and every river card. A player cannot have one size on one river and a different size on another. That is the postflop tree shape used by PioSOLVER. This project does not include PioSOLVER's solver. The regret update is still vanilla CFR or CFR+.

Sizes are pot fractions. A list given for one street replaces the shared list on that street only. A street with no raise list of its own uses that street's bet list. The shared lists still apply where no street list is set.

A geometric size splits the chips still behind into equal pot fractions over the streets that remain, including the current one. With `S` streets left, pot `P`, and stack left `E`, the fraction is

`( (1 + 2E/P) ^ (1/S) - 1 ) / 2`.

One street left, that fraction is all-in. PioSOLVER's geometric size is this split.

An all-in threshold is a fraction of the starting stack. A size that would commit more than that fraction is replaced by all-in, when all-ins are allowed. Zero leaves every listed size unchanged.

`--accuracy 0.05` stops when the Nash gap divided by the pot is at or below 0.05. The printed Nash gap is still NashConv. The fraction of pot is printed beside it and is not NashConv/2.

At most eight actions are legal at one decision. A tree with more than 200,000 terminals is rejected.

## Checked values

On `Ah Kd 7c 4s`, queens versus jacks, check-only, the solver's value matches an independent average over the 44 rivers. The Nash gap is 0. Two in-position hands that share the out-of-position hand share that player's turn information set and, on a river card in neither hand, the river information set as well.

On `Kh Kd 7c 4s`, `AhAd` versus `2c3d` wins every river. Check-down is worth +50. With one pot-sized all-in and no raises, CFR+ at 400 iterations reached 50.0016209123 with Nash gap 0.00187032418952. The gap at 20 iterations was 0.714285714286.

On the flop `Ah Kd 7c`, queens versus jacks, check-only, the value matches the average over all 1,980 turn-and-river runouts: 41.6161616162. The gap is 0.

## Command line

```sh
street_solver
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1 --algorithm vanilla
street_solver --board Ah,Kd,7c,4s --pot 100 --stack 300 --oop-range QcQd --ip-range JcJd --geometric --iterations 200
```

The default is the turn lock above, solved on the public tree. `--reference` solves the same spot by walking `StreetGame`. The reported Nash gap is NashConv, not NashConv/2.
