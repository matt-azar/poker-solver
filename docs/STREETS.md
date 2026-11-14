# Flop, turn, and river

Heads-up no-limit tree on a 3-card flop, 4-card turn, or 5-card river. Boards differ by cards still to come: two, one, or zero.

**Shipping on `main`:** the production Study engine is Zig (`engine/` Session + `solver-engine` typed IPC). Names like `StreetBatchSolver`, `street_solver`, `include/solver/…`, and Explorer `POST /api/…` below are **historical C++ vocabulary** for the same public-tree algorithms — not a live CMake / HTTP product path. See [ARCHITECTURE.md](ARCHITECTURE.md), [DESKTOP_UI.md](DESKTOP_UI.md).

`StreetBatchSolver` (historical) stores the betting structure once and reuses it on every runout. The Zig Session implements the same public-tree idea. It applies the same CFR, CFR+, DCFR(α, β, γ) (default 1.5, 0, 2), and PCFR+ (predictive RM+) update as `CfrTrainer<StreetGame>` on the paths each algorithm supports. A pass freezes regret matching, sums that player's counterfactual regret, then CFR+ / PCFR+ floors only the player who just updated. PCFR+ matches on cumulative regret plus the previous pass's instantaneous CF regret (`m`), then stores the new instantaneous vector as `m` for the next pass (cold-start `m=0`; PSOL v3 may restore `m`, while v1/v2 reloads cold-start prediction). DCFR keeps signed regrets and discounts that player's full row once after the pass (`t^α/(t^α+1)` on positives, `t^β/(t^β+1)` on non-positives) with average weight `t^γ`. Defaults are α=1.5, β=0, γ=2 (`--dcfr-alpha/beta/gamma`); β=0 yields the familiar 0.5 negative discount. Actual DCFR params are stored in PSOL v3 when present on Save. Vanilla regrets stay signed. DCFR and PCFR+ require `--frozen` on the public tree (and the Explorer frozen combo pass); the non-frozen walk and legacy `RiverBatchSolver` reject them. A child is reached with probability equal to the frozen strategy. Own-reach averaging uses the acting player's reach. A hand that meets the board, or that has no compatible opponent left, is structurally unsupported and has no information set. A supported hand with zero strategic reach still has a slot and still receives a counterfactual value. `street_solver` uses the public tree unless `--reference` is set. `--frozen` is one public-tree pass per player. Hands stay unbucketed. Deals are deterministic. CFR+ is the default.

Historically, `StreetGame` and `StreetBatchSolver` accepted all three board lengths; five-card information-set labels matched `RiverGame`. On `main`, Study and CLI entry points use the Zig Session / `solver-engine` path instead of C++ `explorer` / `river_solver`.

Chance deals an ordered hand pair from the joint distribution on the starting board, then the players bet. When the street ends without a fold, the next card is dealt uniformly from the cards that are not on the board and not in either hand. A turn tree deals the river. A flop tree deals the turn and then the river. A five-card tree has no later public cards. A fold ends the hand. Chips already invested stay in the pot, and the next street starts with no bet to call.

Player 0 is out of position and acts first on every street. Utilities use the same net-chip rule as the river: `pot / 2` is the dead money each player already posted, and investments on these streets are added on top. That sum is the full net-chip result. Optional pot rake (`StreetConfig::rake`, CLI `--rake-rate` / `--rake-cap`) is applied at terminals the same way as on the river; see [RAKE.md](auxiliary/payoffs/RAKE.md). Optional tournament ICM (`StreetConfig::icm`, CLI `--icm-stacks` / `--icm-payouts`) wraps those chip terminals; see [ICM.md](auxiliary/payoffs/ICM.md). Optional action-label incentives (`StreetConfig::incentives`, CLI `--incentive`) are path-attributed at terminals after chip/ICM; see [INCENTIVES.md](auxiliary/payoffs/INCENTIVES.md). A finished solve can also report each combo's conditional action value at one decision: force that action once, then follow the stored average. The definition is in [MATHEMATICS.md](MATHEMATICS.md). Study host `categories` reports made-hand category mass (`HighCard`…`StraightFlush`) on five-card boards and multi-label draw/backdoor tags on flop/turn (historical C++: `StreetBatchSolver::category_composition` / `poker::holdem::category_composition`).

An information set is the acting player's own hand, the cards already dealt, and the public action line. It does not contain the opponent's hand. A turn decision is one node, shared by every river that can follow it.

The betting lines are the same on every turn card and every river card. A player cannot have one size on one river and a different size on another. That is the postflop tree shape used by PioSOLVER. This project does not include PioSOLVER's solver. The regret update is vanilla CFR, CFR+, optional DCFR(1.5, 0, 2), or optional PCFR+.

Sizes are pot fractions in `street-config 1` and on the CLI (`0.5` is half pot). A list given for one street replaces the shared list on that street only. A zero-length street list still uses the shared list. A list whose only token is `-` is explicit-empty: that situation is check-only and does not inherit the shared list. Raise lists stay separate from bet lists. A zero-length raise list is no pot-fraction raise (multiples, `e`, and all-in can still apply). The engine does not copy bet sizes into an empty raise list. Study Build uses pot percentages (`50` = half pot) and resolves inherited empty street lists into shared sizes when opening a config so editable fields rebuild the same tree; blank Build bet boxes encode as explicit-empty.

A negative size is a fixed chip amount: `-20`, or `20c` on the command line, bets 20 chips. `75%` is 75% of the pot. `a` always adds all-in, including a short all-in when the all-in switch is off. A raise written `2.5x` raises to 2.5 times the opponent's street total and is valid on a raise list. If the shared multiple list is set and the raise list is empty, the bet sizes are not reused as raises.

`e` is the geometric size over the streets still to play at that node (flop 3, turn 2, river 1, which is all-in). `2e` and `3e` split the stack behind into that many equal pot-fraction bets, computed from the pot and stack at the decision, not from the root. A facing raise subtracts raises already made on the street (the opening bet does not count) and never goes below 1. List `e` on each size field where you want it; there is no separate geometric flag or CLI switch.

OOP donk sizes are used only when IP bet or raised the previous street and OOP is first to act. A zero-length donk list keeps the normal bet sizes. An explicit-empty donk list (`-`) can only check in the donk spot. A per-street donk list overrides the shared donk list. A checked-through street leaves the normal bet sizes. The first street has no donk.

`--pot-cap 1` cuts any larger bet or raise increment down to the pot, after calling when facing a bet. Zero leaves the size unchanged. `--no-three-bet` allows a bet and one raise, and removes the re-raise. `max-raises` counts facing raises only. `1` allows one raise and no 3-bet. `0` allows bets and forbids raises.

A geometric size splits the chips still behind into equal pot fractions over the streets that remain, including the current one. With `S` streets left, pot `P`, and stack left `E`, the fraction is

`( (1 + 2E/P) ^ (1/S) - 1 ) / 2`.

One street left, that fraction is all-in. PioSOLVER's geometric size is this split.

An all-in threshold is a fraction of the starting stack (Pio "All-in threshold"). A size that would commit more than that fraction is replaced by all-in. Zero leaves every listed size unchanged. A listed size larger than the chips still behind is always re-interpreted as all-in; Study's `allow_all_in: 0` does not drop that shove. The all-in switch adds an *extra* all-in action only when that situation already has a size (including an `a` or `e` token). A blank list with the switch on stays check-only.

`merge-threshold` is a fraction of the larger chip amount (Study's 10% sends `0.1`). Sizes inside that gap collapse to the larger amount. Zero, the default, keeps every distinct amount and is omitted from the config text.

Two listed sizes that round to the same tenth-of-a-chip amount are one action. A raise increment smaller than the previous raise is omitted. The first bet of a street only has to add at least 0.1 chip. An all-in shorter than the minimum raise is kept when all-ins are allowed, when the size was an explicit `a`, or when oversize / all-in-threshold shove-up produced it; other short all-ins are omitted when the switch is off.

Pot, stack, and contributions are stored as integer tenths of a chip (`include/game/chips.hpp`). Config / JSON / CLI values stay in chip units (`pot 100` → 100.0 chips → 1000 tenths). `round(f * pot)` with a tenths pot already yields tenths (for example pot 5.0 and `b75` → 3.8 chips). Terminal utilities and reported EV convert back to chips. Rake still floors in whole chips.

## Canonical configuration

`format_street_config` writes one `street-config 1` document for a `StreetConfig`. `parse_street_config` reads that document. Formatting the parsed value again produces the same text. A `StreetGame` built from the parsed config has the same deals, information sets, decisions, terminals, and opening action labels as a game built from the original.

The first line is `street-config 1`. Each later line is one field. Scalar fields are always written, in this order: `board`, `pot`, `stack`, `oop-range`, `ip-range`, `first-to-act`, `max-raises`, `allow-all-in`, `allow-three-bet`, `all-in-threshold`, `pot-cap`, `rake-rate`, `rake-cap`, `memory-mib`, `threads`. Optional `icm-stacks` / `icm-payouts` follow rake when ICM is enabled. Optional repeatable `incentive` lines follow ICM when rules are present. An empty size list is omitted. A missing size field means an empty list. A list written as `-` is explicit-empty and round-trips. Tokens `e`, `2e`, `a`, `75%`, `20c`, and (on raise lists) `2.5x` round-trip as stored sentinels. A legacy `geometric` key is accepted and ignored. `merge-threshold` is written only when it is not zero, after `pot-cap`. Size fields that are present follow the member order in `StreetConfig`, then `oop-donk`, `oop-flop-donk`, `oop-turn-donk`, `oop-river-donk`, `oop-raise-multiples`, and `ip-raise-multiples`. Optional `tree-edit` lines may repeat; each value is one `TreeEditSet` text line (`force - c`, `remove c/b50 b50`, `add-size - 0.33`). Prefer compact path tokens (`c`, `b50`, `r100`) so spaces do not break the line grammar; display labels also match at apply time.

`StreetConfig::tree_edits` holds a `TreeEditSet`. At each decision, edits whose path matches the public history apply in list order. Force keeps only the named action; Remove drops that action label (Zig keeps the prior legal set when a remove would leave zero actions); AddSize injects one extra bet/raise size (pot fraction on the same basis as listed sizes, or `Nc` absolute chips), subject to the usual min-raise, stack, all-in-threshold shove-up, and pot-cap rules. Duplicate chip amounts are ignored. Paths match `action_label` strings (for example `Check`, `Bet 50`) and the compact tokens TreeEditSet already uses (`c`, `b50`, `r100`, `b100ai`). Soft skips (unknown path, missing force/remove action, illegal or duplicate AddSize, remove that would empty the legal set) do not fail compile; the compiled game lists them as `unapplied_tree_edits` with parallel `unapplied_tree_edit_reasons`. The same apply path runs when the public tree is built.

A range is a combo list in combo-index order. A chip size is written `20c`. A pot fraction is a bare number. Geometric, all-in, explicit-empty, and raise-multiple tokens are written `e`, `2e`, `a`, `-`, and `2.5x`. Shared raise multiples stay plain numbers on their own fields. Flags are `0` or `1`. The document ends with a newline and uses LF endings.

An unknown field, a repeated field, extra space, or a version other than 1 is rejected. The parser does not build the tree. `StreetGame` still rejects a board that is not three, four, or five cards, a nonpositive pot, and a range pair with no legal hands. `street_solver --config file` reads this document. `--config -` reads it from stdin. Later flags override fields from the file. Iterations, algorithm, accuracy, `--reference`, and `--frozen` stay on the command line.

`--accuracy 0.05` stops when Pio Accuracy (average of unilateral BR gains, NashConv/2) divided by the pot is at or below 0.05. Optional trailing unit `fraction` (default) or `chips` selects pot fraction vs absolute chips. The printed `nash_gap` is still NashConv; `accuracy` and `accuracy_fraction_of_pot` are the Pio metric used for stopping. With accuracy armed, each check appends to `accuracy_history`; the solvers print that space-separated list when it is non-empty. `--eval-every N` sets the check cadence (positive integer; rejected if `N <= 0`). On this CLI the default remains every 20 iterations when accuracy is set; `SolveConfig::eval_every` defaults to 1 for library callers.

`--time-limit SECONDS` stops at the next iteration boundary once that many wall-clock seconds have elapsed since the solve loop started. A non-negative value arms the limit. The default is off. The solvers print `time_limit_reached: 1` when the wall clock caused the stop, otherwise `0`. Accuracy and time-limit may both be set; whichever hits first ends the run.

At most eight actions are legal at one decision. `StreetGame` rejects a reference enumeration above 200,000 terminals and tells the caller to use the batch solver. `StreetBatchSolver` does not use that cap, and it does not cap expanded histories. Its limit is `StreetConfig::memory_mib`, default 1024. One mebibyte is 1,048,576 bytes. Zero is rejected.

The budget is the bytes the engine requests from its allocator, checked before that call. A container that grows is charged for the old block and the new block while both exist. Freeing a block releases the charge. If the upstream allocator throws, the charge is rolled back. Construction throws when a request would pass the limit, and the partial tree is freed. The solver keeps every hand and action, deals every card, and holds the configured budget.

Charged storage is the engine object, the public tree and its path and action strings, deal rows, compact slot indexes, regret, strategy-sum, and shared sigma-workspace tables (`float` / `TableScalar`), support, traversal scratch, showdown and best-response buffers, registration temporaries, the rank-cache buffers, and, when more than one thread is requested, each extra worker context and the card-result buffer. The shared sigma workspace is one full-size table used as the frozen strategy during training and rebuilt as the normalized average for evaluation; training and evaluation do not need both at once. PCFR+ may allocate an additional float prediction table on first use. The rank cache is allocated for every legal runout before training, so a pass does not allocate it. `reserved_bytes` is unused reservation credit and is zero after construction. Each charged block includes the header the budget resource writes in front of the user pointer.

Information-set indexing is compact: each public decision owns a `slot_of` map over **legal** public runouts (off-board cards / ordered pairs) times acting-player hands, not a dense `52` or `52×52` grid that includes board cards. Each stored `Slot` is 12 bytes (`node`, table `base`, packed `hand` / `turn` / `river`); action count lives on the public node. Decisions with exactly one legal action are implicit probability 1: they count toward `infoset_count` and strategy export, but allocate no `Slot`, no `slot_of` cells, and no regret / strategy-sum / sigma rows. Locks, average edits, frozen passes, PCFR+, and PSOL reload still apply to stored multi-action slots.

`estimated_peak_bytes` is a plan: payload sizes, one block header per planned buffer, and one map node per runout. `allocated_bytes` and `peak_allocated_bytes` are the resource's live total and high-water mark. `regret_strategy_sum_bytes` is only the regret array plus the strategy-sum array. `sigma_workspace_bytes` is the shared frozen/average cache. Together those three tables are `12` bytes per hand-action entry (`kPersistentTableBytesPerEntry`), down from `32` when the same four roles were separate `double` tables.

Study exposes the labeled plan dry-run as host IPC `plan_memory` (and nested `plan` on `tree_preview`). Historical C++ `street_solver --plan-memory` / Explorer `POST /api/plan-memory` did the same via `kPlanOnly` construction. Do not confuse the three figures: **estimated** is the labeled plan; **measured** `allocated_bytes` / `peak_allocated_bytes` come from a full build; **RSS** is whole-process working set when the OS provides it.

Outside the budget: process RSS, malloc bookkeeping, native thread stacks, the `std::thread` handles, the caller's `StreetConfig` vectors after they are moved in, the budget resource's own stage table, and a later strategy export. The stage table is a few dozen name entries. It does not hold the tree.

Expanded terminals and expanded decisions are 64-bit counts of histories. The frozen walk visits the public tree with a vector of hands. A terminal value is a blocker-corrected sum over those hands. A full-range check-down on `Ah Kd 7c` has 1,271,256 deals, 2,517,086,880 expanded terminals, 5,151,129,312 expanded decision histories, and 5,197,920 stored information sets.

## Frozen pass threads

`--threads N` is the number of threads for the frozen pass, including the caller. The default is 1. One thread uses the serial chance loop. `N` must be an integer from 1 through 64. More than one thread requires `--frozen`; the per-deal walk stays serial. The explorer accepts the same `threads` and `frozen` fields on a flop, a turn, or a river, and rejects threads above 1 when the frozen pass is off.

The first future public card is the split. A turn splits river cards. A flop splits turn cards, and the worker that takes a turn card deals that card's rivers itself. Betting before that chance node stays on the caller. A later chance node, reached by a different line, is another batch after the previous one has joined. Workers do not start further batches.

Scratch, action values, and the showdown reach buffers live in a `WorkerContext`. Each worker keeps a rank-order prefix, a compact per-card prefix, and a rank-ordered opponent-amount scratch used while building those prefixes. Structural board-support masks also store dense supported-hand index lists for terminal collect, fold, and showdown. The hand order, card lists, and interval endpoints for a runout are shared and read-only. The caller has one context. Evaluation uses that context and does not run during a pass. Each extra thread has its own context and a shared card-result buffer, both charged to the budget before any regret update. If they do not fit, construction throws the memory error and keeps the requested thread count. Native thread stacks and the thread handles are outside the budget. Workers do not allocate, free, or change the budget stage.

At one chance node, the next cards have disjoint descendant information sets: a slot stores the public node and the cards already dealt. A worker writes those regret and strategy-sum entries directly. The caller updates the shared ancestors only after every task has joined, and adds the card values in ascending card order with the same chance weight as the serial loop. Own reach may be zero. Chance probabilities use the full card list and stay independent of the thread count.

Rank values are filled on the caller before the first pass. That cost is `cache_init_seconds`. Worker creation is `worker_setup_seconds`. Neither is folded into construction or training. On the full-range flop check-down that fill is about 12 seconds on the Windows run in [BENCHMARKS.md](auxiliary/engineering/BENCHMARKS.md). The warm training loop after the cache exists is a separate number. A worker exception is captured, the other tasks are joined, and later training or evaluation throws. The partial regrets stay in place.

## Checked values

On `Ah Kd 7c 4s`, queens versus jacks, check-only, the solver's value matches an independent average over the 44 rivers. The Nash gap is 0. Two in-position hands that share the out-of-position hand share that player's turn information set and, on a river card in neither hand, the river information set as well.

On `Kh Kd 7c 4s`, `AhAd` versus `2c3d` wins every river. Check-down is worth +50. With one pot-sized all-in and no raises, CFR+ at 400 iterations reached 50.0016209123 with Nash gap 0.00187032418952. The gap at 20 iterations was 0.714285714286.

On the flop `Ah Kd 7c`, queens versus jacks, check-only, the value matches the average over all 1,980 turn-and-river runouts: 41.6161616162. The gap is 0.

## Command line

```sh
street_solver
street_solver --config configs/street_default.txt
street_solver --config configs/street_default.txt --plan-memory
street_solver --config configs/street_default.txt --iterations 200
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1 --algorithm vanilla
street_solver --board Ah,Kd,7c --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024 --threads 4
street_solver --board Ah,Kd,7c,4s --pot 100 --stack 300 --oop-range QcQd --ip-range JcJd --oop-bets e --ip-bets e --oop-raises e --ip-raises e --iterations 200
street_solver --board Ah,Kd,7c,4s,2h --oop-range AcAd,5c5d --ip-range KsKc --oop-bets 1 --no-all-in --max-raises 1 --iterations 40
street_solver --board Ah,Kd,7c --oop-donk 40c --oop-bets 1 --ip-bets 0.5 --no-all-in --max-raises 1 --iterations 1
street_solver --board Ah,Kd,7c,4s,2h --oop-range AcAd --ip-range KsKc --no-all-in --max-raises 0 --rake-rate 0.05 --iterations 1
street_solver --config configs/street_default.txt --iterations 40 --report report.txt
```

The default is the turn lock above, solved on the public tree. `configs/street_default.txt` is that same spot as a `street-config 1` document. `--reference` solves the same spot by walking `StreetGame`. The reported Nash gap is NashConv.

## Strategy report

`--report FILE` writes a `strategy-report 1` document after the solve. Use `-` for stdout. The file is a line-oriented schema: board, pot, stack, algorithm, iterations, nash_gap, weighting, root-player, and one `root-action LABEL P` line per legal root action. On the public or frozen tree, root probabilities are the CFR average strategy mixed with **reach** weights across the acting player's hands at the root. The reference enumerator path writes the same summary fields but omits root-action lines. This is a script-facing export, not a batch queue.
