# Mathematics

Definitions used by the Hold'em street/river solvers and by the Kuhn/Leduc reference games that verify the shared CFR trainer.

## Hold'em showdown and hand distributions

Hand categories are totally ordered: high card, pair, two pair, three of a kind, straight, flush, full house, four of a kind, straight flush. Within a category, five rank tiebreaks compare from most significant to least. The wheel `A-2-3-4-5` uses the five as its straight rank (tiebreak 3) and loses to a six-high straight.

A range is a nonnegative weight on each of the 1,326 unordered two-card hands. Given two ranges and a board, the joint distribution is over **ordered** pairs `(h0, h1)`:

\[
P(h_0, h_1) \propto w_0(h_0)\, w_1(h_1)
\]

when `h0`, `h1`, and the board are pairwise disjoint, and `P = 0` otherwise. The constant is the sum of those products. If that sum is zero, the distribution is empty. With both weights equal to 1 and an empty board, the sum is `1326 * C(50, 2) = 1326 * 1225`.

## River and street utilities

The river tree uses that joint distribution as its only chance node. Player 0 is out of position. Both players have the same stack behind; the pot was posted equally on earlier streets.

Player 0's terminal utility is `pot / 2` plus the opponent's river investment when player 0 wins or the opponent folds, and the negation of `pot / 2` plus player 0's own river investment when player 0 loses or folds. A split pot is worth 0 once the river investments match. `ChipPayoff` returns both players' utilities under this rule; chip EV stays zero-sum so player 1 is the negation of player 0. Optional pot rake subtracts the house take from the winner (or half each on a tie); see [RAKE.md](RAKE.md). Optional ICM wraps those chip terminals; see [ICM.md](ICM.md).

An opening fraction `f` bets `round(f * pot)` chips. A raise fraction `f` increases the bet by `round(f * pot_after_the_call)`. The minimum later raise equals the previous full bet or raise. Details and a solved toy are in [RIVER.md](RIVER.md).

A turn tree adds one chance node after turn betting: the river, uniform over remaining cards. A flop tree adds two. A five-card tree adds none. Range weights enter only through the root hand distribution. `StreetBatchSolver` solves all three board lengths on one public tree and pins five-card results against `RiverGame`. The chip rule is the river rule with investments summed across the streets still to play. See [STREETS.md](STREETS.md).

Checked cases:

- `Kh Kd 7c 4s`, aces against `2c3d`: check-down +50; CFR+ at 400 iterations reached 50.0016209123 with Nash gap 0.00187032418952.
- `Ah Kd 7c`, queens against jacks: check-down over 1,980 runouts is 41.6161616162; the solver matches with Nash gap 0.

## Vanilla CFR

Let \(I\) be an information set, \(\sigma^t(I,\cdot)\) the iterate strategy, and \(R^t(I,a)\) cumulative regret.

**Regret matching** (uniform if the denominator is 0):

\[
\sigma^{t+1}(I,a)
=
\frac{\max(R^t(I,a),0)}
{\sum_b \max(R^t(I,b),0)}.
\]

**Immediate counterfactual regret** at history \(h \in I\), with utilities in player-\(i\) chips:

\[
r^t(I,a)
=
\pi_{-i}^t(h)\,
\bigl(v^t(h\cdot a) - v^t(h)\bigr),
\]

where \(\pi_{-i}^t(h)\) is opponent reach times chance reach, and \(v^t\) is expected utility under \(\sigma^t\). Cumulative regret sums these over all \(h \in I\) and iterations.

**Average strategy** is reach-weighted by the acting player's probability of reaching the infoset:

\[
\bar\sigma^T(I,a)
\propto
\sum_{t=1}^{T} \pi_i^t(I)\, \sigma^t(I,a).
\]

Reported expected utility is \(u(\bar\sigma)\) under both players' average strategies and chance.

## CFR+

CFR+ changes three things relative to the vanilla update. The counterfactual regret \(r^t(I,a)\) is unchanged.

**Regret flooring** (regret-matching+):

\[
R^{t+1}(I,a) = \max\left(0, R^t(I,a) + r^t(I,a)\right).
\]

**Alternating updates.** Iteration \(t\) (starting at 1) updates player 0, then player 1. Each pass freezes regret matching at the start and holds that strategy for the whole pass. Counterfactual regret is summed across the pass. The floor above is applied once, to the player who just updated, after that sum. The other player's regret table stays unchanged. Vanilla CFR and linear CFR use one pass for both players and leave regrets signed. This is the usual CFR+ schedule (Tammelin, 2014), with the floor taken after the information-set sum.

**Iteration-weighted averaging.** The average strategy still multiplies by the acting player's reach, and also by the iteration index:

\[
\bar\sigma^T(I,a)
\propto
\sum_{t=1}^{T} t \, \pi_i^t(I) \, \sigma^t(I,a).
\]

A player's average is accumulated only on that player's traversal. Vanilla CFR uses the same reach weight with \(t\) replaced by 1, and updates both players in a single traversal.

## Linear CFR and DCFR

Linear CFR uses the vanilla schedule: one traversal updates both players. On iteration \(t\), starting at 1, the new regret and the average-strategy contribution are both multiplied by \(t\). Regrets are not floored. See [HUNL.md](HUNL.md).

Fixed DCFR(α=1.5, β=0, γ=2) uses alternating frozen passes like CFR+, keeps signed regrets, discounts the updating player's full row once after the pass with \(t^{1.5}/(t^{1.5}+1)\) on positives and \(0.5\) on non-positives, and averages with weight \(t^2\). DCFR requires the frozen pass on the public tree. See [STREETS.md](STREETS.md).

`RiverBatchSolver` / `StreetBatchSolver` use the same updates on the public tree. Deals visit in joint-distribution order. Own-reach averaging uses the acting player's reach. Because a river information set is exactly one private hand plus one public history, a single bottom-up pass that maximizes player 0's chips and minimizes them for player 1 (ties to the lower action index) matches deepest-first best response.

## Best response and Nash gap

With \(\bar\sigma_{-i}\) frozen, player \(i\)'s best response maximizes that player's utility. The **Nash gap** reported by the CLI is NashConv:

\[
u_0(\mathrm{BR}_0,\bar\sigma_1) + u_1(\bar\sigma_0,\mathrm{BR}_1).
\]

It is zero at Nash. Pio reports the average of the two unilateral gains; convert before comparing. Accuracy stopping uses NashConv / pot.

One checked river toy: pot 100, one all-in, aces or fives against kings. Equilibrium value for OOP is +25 (aces always bet, fives bet 1/2, kings call 1/2). CFR+ at 4,000 iterations reached 24.9999102275; Nash gap fell from 2.45089917903 at 40 iterations to 0.196997733488.

## Conditional action values

These values are read from a finished street solve. They do not train and do not use current regret matching. The profile is the stored average.

At a decision for player \(i\), public history \(H\), and board \(B\), write \(q_{\mathrm{opp}}(g)\) for the opponent's input weight times the average-policy probabilities along the history. Hands that cannot exist on \(B\) are removed. For a hero hand \(h\),

\[
D_i(h)=\sum_g q_{\mathrm{opp}}(g)
\]

over opponent hands \(g\) compatible with \(h\) and \(B\). The query forms that sum by subtracting blocked opponent mass from the total when the subtraction is stable. When subtraction cancels (including when a blocked opponent dominates a tiny compatible hand), the query adds the compatible hands directly. The same rule covers showdown win/lose buckets and posterior marginals. A negative residual is not a reach. Structural support stays separate from that floating-point residual. When \(h\) is structurally supported and \(D_i(h)>0\),

\[
Q_i(h,a)=\sum_g \frac{q_{\mathrm{opp}}(g)}{D_i(h)}\, E[U_i \mid H, B, h, g, \text{force } a, \text{ then follow the average}].
\]

Future cards are dealt from the deck that remains for that fixed pair. Forcing \(a\) does not multiply by the average probability of \(a\). A legal action with probability zero still has a continuation value. Later decisions follow the average. This is not a best response.

\(U_i\) is root-centered terminal utility in chips, with \(U_1=-U_0\) when rake is zero. The number includes chips already invested. Folding is worth \(-(initial\ pot/2 + that\ player's\ cumulative\ contribution)\). A tie is 0. The stored root EV is player 0's expected utility. At an in-position decision the reported value is the negation of the player-0 amount the terminal kernel stores. The M8 payoff abstraction (`PlayerPayoff`) carries both utilities; street/river solvers pass `config.rake` into terminals while still training on the player-0 chip scalar.

If \(D_i(h)=0\), \(Q_i(h,a)\) is undefined. The query does not invent a uniform opponent range. A hand that is off the board, or otherwise structurally unsupported, is undefined. Hero's own strategic reach can be zero while \(D_i(h)>0\); the counterfactual continuation is still defined. Reach-defined and EV-defined are separate.

The mixed hand value is \(V_i(h)=\sum_a \bar\sigma_i(h,a)\, Q_i(h,a)\).

Where the posterior marginal \(m_i(h)\) exists, the node value is \(\sum_h m_i(h)\, V_i(h)\). At the root this is the stored EV from the actor's side: player 0's utility when OOP acts, and its negation when IP acts. A group's mixed value averages over the hands in the group with those same marginals. Those aggregates are not NashConv, cumulative regret, or a best-response gain.

## Kuhn reference (trainer verification)

Kuhn Poker is a two-player zero-sum imperfect-information game used to pin the shared CFR trainer. Deck `{Jack, Queen, King}`; each player posts a unit ante; player 1 acts first (Check or Bet 1). Tree: [ARCHITECTURE.md](ARCHITECTURE.md). Equilibrium game value for player 1:

\[
V = -\frac{1}{18}.
\]

Equilibrium strategies form a family parameterized by \(\alpha \in [0, 1/3]\) (Kuhn, 1950). Tests check that family and that both vanilla CFR and CFR+ approach \(V\) with Nash gap below \(10^{-3}\) at 200,000 iterations. Measured times: [BENCHMARKS.md](BENCHMARKS.md).
