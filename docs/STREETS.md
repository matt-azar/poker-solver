# Turn and flop

`StreetGame` is a heads-up no-limit tree on a 4-card turn or a 3-card flop. `StreetBatchSolver` stores that betting structure once and reuses it on every runout. It applies the same CFR and CFR+ update as `CfrTrainer<StreetGame>`. A pass freezes regret matching, sums that player's counterfactual regret, then CFR+ floors only the player who just updated. Vanilla regrets stay signed. There is no fixed exploration mixture: a child is reached with probability equal to the frozen strategy. Own-reach averaging is not gated on the opponent's reach. A hand that meets the board, or that has no compatible opponent left, is structurally unsupported and is not an information set. A supported hand with zero strategic reach still has a slot and still receives a counterfactual value. `street_solver` uses the public tree unless `--reference` is set. `--frozen` is one public-tree pass per player. Once the pass contract matches, its action probabilities match the per-deal walk. `RiverGame` is still the one-street river. There is no hand bucketing and no RNG.

Chance deals an ordered hand pair from the joint distribution on the starting board, then the players bet. When the street ends without a fold, the next card is dealt uniformly from the cards that are not on the board and not in either hand. A turn tree deals the river. A flop tree deals the turn and then the river. A fold ends the hand. Chips already invested stay in the pot, and the next street starts with no bet to call.

Player 0 is out of position and acts first on every street. Utilities use the same net-chip rule as the river: `pot / 2` is the dead money each player already posted, and investments on these streets are added on top. Uncalled chips are not extra profit.

An information set is the acting player's own hand, the cards already dealt, and the public action line. It does not contain the opponent's hand. A turn decision is one node, shared by every river that can follow it.

The betting lines are the same on every turn card and every river card. A player cannot have one size on one river and a different size on another. That is the postflop tree shape used by PioSOLVER. This project does not include PioSOLVER's solver. The regret update is still vanilla CFR or CFR+.

Sizes are pot fractions. A list given for one street replaces the shared list on that street only. A street with no raise list of its own uses that street's bet list. The shared lists still apply where no street list is set.

A negative size is a fixed chip amount: `-20`, or `20c` on the command line, bets 20 chips. A raise written `3x` raises to three times the opponent's street total. If that multiple list is set and the raise list is empty, the bet sizes are not reused as raises.

OOP donk sizes are used only when IP bet or raised the previous street and OOP is first to act. A checked-through street leaves the normal bet sizes. The first street has no donk.

`--pot-cap 1` cuts any larger bet or raise increment down to the pot, after calling when facing a bet. Zero leaves the size unchanged. `--no-three-bet` allows a bet and one raise, and removes the re-raise.

A geometric size splits the chips still behind into equal pot fractions over the streets that remain, including the current one. With `S` streets left, pot `P`, and stack left `E`, the fraction is

`( (1 + 2E/P) ^ (1/S) - 1 ) / 2`.

One street left, that fraction is all-in. PioSOLVER's geometric size is this split.

An all-in threshold is a fraction of the starting stack. A size that would commit more than that fraction is replaced by all-in, when all-ins are allowed. Zero leaves every listed size unchanged.

`--accuracy 0.05` stops when the Nash gap divided by the pot is at or below 0.05. The printed Nash gap is still NashConv. The fraction of pot is printed beside it and is not NashConv/2.

At most eight actions are legal at one decision. `StreetGame` rejects a reference enumeration above 200,000 terminals and tells the caller to use the batch solver. `StreetBatchSolver` does not use that cap, and it does not cap expanded histories. Its limit is `StreetConfig::memory_mib`, default 1024. One mebibyte is 1,048,576 bytes. Zero is rejected. The budget is solver-owned heap: the public tree, deal rows, slot indexes, regret and average tables, support, traversal scratch, the reserved rank-cache bound, and the showdown and best-response buffers. It is not process RSS, and it does not include the executable, thread stacks, allocator bookkeeping, the caller's ranges, or a later strategy export. The solver plans that total before it allocates the large tables. If the plan does not fit, construction throws and frees the partial tree. It does not drop hands, drop actions, sample cards, or raise the budget.

Expanded terminals and expanded decisions are 64-bit counts of histories. They are not stored nodes. A full-range check-down on `Ah Kd 7c` has 1,271,256 deals, 2,517,086,880 expanded terminals, 5,151,129,312 expanded decision histories, and 5,197,920 stored information sets.

## Checked values

On `Ah Kd 7c 4s`, queens versus jacks, check-only, the solver's value matches an independent average over the 44 rivers. The Nash gap is 0. Two in-position hands that share the out-of-position hand share that player's turn information set and, on a river card in neither hand, the river information set as well.

On `Kh Kd 7c 4s`, `AhAd` versus `2c3d` wins every river. Check-down is worth +50. With one pot-sized all-in and no raises, CFR+ at 400 iterations reached 50.0016209123 with Nash gap 0.00187032418952. The gap at 20 iterations was 0.714285714286.

On the flop `Ah Kd 7c`, queens versus jacks, check-only, the value matches the average over all 1,980 turn-and-river runouts: 41.6161616162. The gap is 0.

## Command line

```sh
street_solver
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1 --algorithm vanilla
street_solver --board Ah,Kd,7c --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024
street_solver --board Ah,Kd,7c,4s --pot 100 --stack 300 --oop-range QcQd --ip-range JcJd --geometric --iterations 200
street_solver --board Ah,Kd,7c --oop-donk 40c --oop-bets 1 --ip-bets 0.5 --no-all-in --max-raises 1 --iterations 1
```

The default is the turn lock above, solved on the public tree. `--reference` solves the same spot by walking `StreetGame`. The reported Nash gap is NashConv, not NashConv/2.
