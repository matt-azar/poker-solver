# Mathematics (Phase 2)

Kuhn Poker is modeled as a two-player, zero-sum extensive-form game with imperfect information and perfect recall.

## Kuhn rules used here

- Deck `{Jack, Queen, King}`. Each player is dealt one private card; the unused card is discarded.
- Each player posts a unit ante. Starting pot is 2.
- Player 1 acts first: Check or Bet (size 1). Then the tree in [ARCHITECTURE.md](ARCHITECTURE.md).
- Showdown: higher rank wins the pot. Fold: the player who bet wins the pot.
- Player-1 net utility examples:
  - Check-check: `±1`
  - Bet-call or check-bet-call: `±2`
  - Bet-fold: `+1` for player 1
  - Check-bet-fold: `-1` for player 1

The equilibrium **game value** for player 1 is unique:

\[
V = -\frac{1}{18}.
\]

The equilibrium **strategy** is not unique. With \(\alpha \in [0, 1/3]\), one family (Kuhn, 1950) is:

| Infoset | Equilibrium frequency |
| --- | --- |
| P1 Jack, first action | Bet with probability \(\alpha\) |
| P1 Queen, first action | Check |
| P1 King, first action | Bet with probability \(3\alpha\) (not always, unless \(\alpha = 1/3\)) |
| P1 Jack facing a bet | Fold |
| P1 Queen facing a bet | Call with probability \(\alpha + 1/3\) |
| P1 King facing a bet | Call |
| P2 Jack facing a check | Bet with probability \(1/3\) |
| P2 Queen facing a check | Check |
| P2 King facing a check | Bet |
| P2 Jack facing a bet | Fold |
| P2 Queen facing a bet | Call with probability \(1/3\) |
| P2 King facing a bet | Call |

Queen’s call probability is \(\alpha + 1/3\), not a constant \(1/3\). At \(\alpha = 0.22\), that call rate is about \(0.55\). Vanilla CFR from zero regret can converge to an interior \(\alpha\); tests check this family rather than forcing King to bet with probability 1.

That value identity is a verification target. The solver does not hardcode equilibrium frequencies.

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

where \(\pi_{-i}^t(h)\) is opponent reach times chance reach, and \(v^t\) is expected utility under \(\sigma^t\). Cumulative regret is the sum of these quantities over all \(h \in I\) and iterations.

This implementation enumerates all six chance deals each iteration (no sampling, no RNG).

**Average strategy** is reach-weighted by the acting player’s probability of reaching the infoset (not the last iterate):

\[
\bar\sigma^T(I,a)
\propto
\sum_{t=1}^{T} \pi_i^t(I)\, \sigma^t(I,a).
\]

Reported expected utility is \(u_1(\bar\sigma)\), obtained by traversing the tree with both players’ average strategies and chance probabilities.

## CFR+

CFR+ changes three things relative to the vanilla update above. The counterfactual regret \(r^t(I,a)\) is unchanged.

**Regret flooring** (regret-matching+):

\[
R^{t+1}(I,a) = \max\left(0, R^t(I,a) + r^t(I,a)\right).
\]

**Alternating updates.** Iteration \(t\) (starting at 1) makes one full traversal that updates only player 1, then one full traversal that updates only player 2. During a player’s traversal the opponent’s strategy is the current regret-matching strategy, including regrets written earlier in the same iteration. This is the usual CFR+ schedule (Tammelin, 2014). It is not part of the regret formula itself.

**Iteration-weighted averaging.** The average strategy still multiplies by the acting player’s reach, and also by the iteration index:

\[
\bar\sigma^T(I,a)
\propto
\sum_{t=1}^{T} t \, \pi_i^t(I) \, \sigma^t(I,a).
\]

A player’s average is accumulated only on that player’s traversal, so the two passes in one iteration do not double-count it. Vanilla CFR uses the same reach weight with \(t\) replaced by 1, and updates both players in a single traversal.

On Kuhn, both algorithms approach \(V=-1/18\). At equal iteration counts CFR+ eventually reports a smaller Nash gap. Each CFR+ iteration walks the tree twice, so a smaller gap does not by itself mean a shorter wall-clock solve. Measured times are in [BENCHMARKS.md](BENCHMARKS.md).

## Linear CFR

Linear CFR uses the vanilla schedule: one traversal updates both players. On iteration \(t\), starting at 1, the new regret and the average-strategy contribution are both multiplied by \(t\). Regrets are not floored. At 10,000 Kuhn iterations it is closer to \(-1/18\) than vanilla CFR, and vanilla CFR has the smaller Nash gap. It is a weighting, not a solution of unrestricted Hold'em. See [HUNL.md](HUNL.md).

## Best response and Nash gap

With \(\bar\sigma_{-i}\) frozen, player \(i\) has six infosets and two actions, so 64 pure plans. The solver evaluates all of them. Let

\[
u_1(\mathrm{BR}_1,\bar\sigma_2),\qquad
u_2(\bar\sigma_1,\mathrm{BR}_2)
\]

be the resulting values. The **Nash gap** reported by the CLI is NashConv:

\[
u_1(\mathrm{BR}_1,\bar\sigma_2) + u_2(\bar\sigma_1,\mathrm{BR}_2).
\]

It is zero at Nash. Some papers call **exploitability** NashConv/2; this project does not report that number under the name exploitability.

## What convergence does and does not mean

Shrinking Nash gap on Kuhn means the average profile is approaching a Nash equilibrium **of this Kuhn game**. It is not evidence about abstract Hold’em betting trees or unrestricted no-limit Texas Hold’em.

## Hold'em showdown and hand distributions

Phase 5 does not define a betting game. It defines the showdown order and the distribution over private hands used by a later tree.

Hand categories are totally ordered: high card, pair, two pair, three of a kind, straight, flush, full house, four of a kind, straight flush. Within a category, five rank tiebreaks are compared from the most significant to the least. The wheel `A-2-3-4-5` uses the five as its straight rank, so its tiebreak is 3 and it loses to a six-high straight.

A range is a nonnegative weight on each of the 1,326 unordered two-card hands. Given two ranges and a board, the joint distribution is over **ordered** pairs `(h0, h1)`:

\[
P(h_0, h_1) \propto w_0(h_0)\, w_1(h_1)
\]

when `h0`, `h1`, and the board are pairwise disjoint, and `P = 0` otherwise. The constant is the sum of those products. If that sum is zero, the distribution is empty rather than uniform. With both weights equal to 1 and an empty board, the sum is `1326 * C(50, 2) = 1326 * 1225`.

## River subgame

The river tree uses that joint distribution as its only chance node. Player 0 is out of position. Both players have the same stack behind, and the pot was posted equally.

Player 0's terminal utility is `pot / 2` plus the opponent's river investment when player 0 wins or the opponent folds, and the negation of `pot / 2` plus player 0's own river investment when player 0 loses or folds. A split pot is worth 0 once the river investments match. Uncalled chips are not added on top of that.

An opening fraction `f` bets `round(f * pot)` chips. A raise fraction `f` increases the bet by `round(f * pot_after_the_call)`. The minimum later raise equals the previous full bet or raise. Details and a solved toy are in [RIVER.md](RIVER.md).

`RiverBatchSolver` does not change that update. Deals are visited in joint-distribution order, and each deal updates regrets before the next deal starts. CFR+ still floors a regret at zero before the next deal. The average strategy is still accumulated once per visit, with weight `1` or the iteration index times the acting player's reach, and chance is not part of that weight. Because a river information set is exactly one private hand plus one public history, a single bottom-up pass that maximizes player 0's chips and minimizes them for player 1, breaking ties toward the lower action index, is the same best response as the deepest-first walk.

One checked case: pot 100, one all-in, aces or fives against kings. The equilibrium value for the out-of-position player is +25, with aces always betting, fives betting half the time, and kings calling half the time. CFR+ at 4,000 iterations reached a value of 24.9999102275. The Nash gap fell from 2.45089917903 at 40 iterations to 0.196997733488. That gap is NashConv for this bet-size tree, not for every legal chip size.

## Turn and flop

A turn tree has one more chance node after the turn betting ends: the river, uniform over the remaining cards. A flop tree has two, the turn and then the river. Range weights enter only through the root hand distribution. A card that is not dealt yet is not part of the acting player's information. The chip rule is the river rule, with investments summed across the streets still to play. See [STREETS.md](STREETS.md).

On `Kh Kd 7c 4s`, aces against `2c3d` win every river, so check-down is worth +50. With one pot-sized bet, CFR+ for 400 iterations reached 50.0016209123 and a Nash gap of 0.00187032418952. On `Ah Kd 7c`, queens against jacks, the check-down value over all 1,980 runouts is 41.6161616162, and the solver matches it with Nash gap 0.
