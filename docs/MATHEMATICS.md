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

The equilibrium **strategy** is a family. With \(\alpha \in [0, 1/3]\), one family (Kuhn, 1950) is:

| Infoset | Equilibrium frequency |
| --- | --- |
| P1 Jack, first action | Bet with probability \(\alpha\) |
| P1 Queen, first action | Check |
| P1 King, first action | Bet with probability \(3\alpha\) (equal to 1 only at \(\alpha = 1/3\)) |
| P1 Jack facing a bet | Fold |
| P1 Queen facing a bet | Call with probability \(\alpha + 1/3\) |
| P1 King facing a bet | Call |
| P2 Jack facing a check | Bet with probability \(1/3\) |
| P2 Queen facing a check | Check |
| P2 King facing a check | Bet |
| P2 Jack facing a bet | Fold |
| P2 Queen facing a bet | Call with probability \(1/3\) |
| P2 King facing a bet | Call |

Queen’s call probability is \(\alpha + 1/3\). At \(\alpha = 0.22\), that call rate is about \(0.55\). Vanilla CFR from zero regret can converge to an interior \(\alpha\). Tests check this family.

That value identity is a verification target. The solver reaches those frequencies by regret matching.

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

This implementation enumerates all six chance deals each iteration.

**Average strategy** is reach-weighted by the acting player’s probability of reaching the infoset:

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

**Alternating updates.** Iteration \(t\) (starting at 1) updates player 1, then player 2. Each pass freezes regret matching at the start and holds that strategy for the whole pass. Counterfactual regret is summed across the pass. The floor above is applied once, to the player who just updated, after that sum. The other player's regret table stays unchanged. Vanilla CFR and linear CFR use one pass for both players and leave regrets signed. This is the usual CFR+ schedule (Tammelin, 2014), with the floor taken after the information-set sum.

**Iteration-weighted averaging.** The average strategy still multiplies by the acting player’s reach, and also by the iteration index:

\[
\bar\sigma^T(I,a)
\propto
\sum_{t=1}^{T} t \, \pi_i^t(I) \, \sigma^t(I,a).
\]

A player’s average is accumulated only on that player’s traversal, so the two passes in one iteration count it once. Vanilla CFR uses the same reach weight with \(t\) replaced by 1, and updates both players in a single traversal.

On Kuhn, both algorithms approach \(V=-1/18\). At equal iteration counts CFR+ eventually reports a smaller Nash gap. Each CFR+ iteration walks the tree twice. Measured times are in [BENCHMARKS.md](BENCHMARKS.md).

## Linear CFR

Linear CFR uses the vanilla schedule: one traversal updates both players. On iteration \(t\), starting at 1, the new regret and the average-strategy contribution are both multiplied by \(t\). Regrets are not floored. At 10,000 Kuhn iterations it is closer to \(-1/18\) than vanilla CFR, and vanilla CFR has the smaller Nash gap. It is a weighting on Kuhn. See [HUNL.md](HUNL.md).

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

It is zero at Nash.

## What convergence means

Shrinking Nash gap on Kuhn means the average profile is approaching a Nash equilibrium **of this Kuhn game**.

## Hold'em showdown and hand distributions

Phase 5 does not define a betting game. It defines the showdown order and the distribution over private hands used by a later tree.

Hand categories are totally ordered: high card, pair, two pair, three of a kind, straight, flush, full house, four of a kind, straight flush. Within a category, five rank tiebreaks are compared from the most significant to the least. The wheel `A-2-3-4-5` uses the five as its straight rank, so its tiebreak is 3 and it loses to a six-high straight.

A range is a nonnegative weight on each of the 1,326 unordered two-card hands. Given two ranges and a board, the joint distribution is over **ordered** pairs `(h0, h1)`:

\[
P(h_0, h_1) \propto w_0(h_0)\, w_1(h_1)
\]

when `h0`, `h1`, and the board are pairwise disjoint, and `P = 0` otherwise. The constant is the sum of those products. If that sum is zero, the distribution is empty. With both weights equal to 1 and an empty board, the sum is `1326 * C(50, 2) = 1326 * 1225`.

## River subgame

The river tree uses that joint distribution as its only chance node. Player 0 is out of position. Both players have the same stack behind, and the pot was posted equally.

Player 0's terminal utility is `pot / 2` plus the opponent's river investment when player 0 wins or the opponent folds, and the negation of `pot / 2` plus player 0's own river investment when player 0 loses or folds. A split pot is worth 0 once the river investments match. That formula is the full terminal utility.

An opening fraction `f` bets `round(f * pot)` chips. A raise fraction `f` increases the bet by `round(f * pot_after_the_call)`. The minimum later raise equals the previous full bet or raise. Details and a solved toy are in [RIVER.md](RIVER.md).

`RiverBatchSolver` uses that same update. Deals are visited in joint-distribution order. The strategy is frozen for the pass, and CFR+ floors one player after that player's deals. The average strategy is still accumulated once per visit, with weight `1` or the iteration index times the acting player's reach. Because a river information set is exactly one private hand plus one public history, a single bottom-up pass that maximizes player 0's chips and minimizes them for player 1, breaking ties toward the lower action index, is the same best response as the deepest-first walk.

One checked case: pot 100, one all-in, aces or fives against kings. The equilibrium value for the out-of-position player is +25, with aces always betting, fives betting half the time, and kings calling half the time. CFR+ at 4,000 iterations reached a value of 24.9999102275. The Nash gap fell from 2.45089917903 at 40 iterations to 0.196997733488. That gap is NashConv for this bet-size tree.

## Turn and flop

A turn tree has one more chance node after the turn betting ends: the river, uniform over the remaining cards. A flop tree has two, the turn and then the river. Range weights enter only through the root hand distribution. The acting player's information is the cards already dealt and the public betting. The chip rule is the river rule, with investments summed across the streets still to play. See [STREETS.md](STREETS.md).

On `Kh Kd 7c 4s`, aces against `2c3d` win every river, so check-down is worth +50. With one pot-sized bet, CFR+ for 400 iterations reached 50.0016209123 and a Nash gap of 0.00187032418952. On `Ah Kd 7c`, queens against jacks, the check-down value over all 1,980 runouts is 41.6161616162, and the solver matches it with Nash gap 0.

## Conditional action values

These values are read from a finished flop or turn solve. They do not train, and they do not use the current regret matching. The profile is the stored average.

At a decision for player \(i\), public history \(H\), and board \(B\), write \(q_{\mathrm{opp}}(g)\) for the opponent's input weight times the average-policy probabilities along the history. Hands that cannot exist on \(B\) are removed. For a hero hand \(h\),

\[
D_i(h)=\sum_g q_{\mathrm{opp}}(g)
\]

over opponent hands \(g\) that are compatible with \(h\) and \(B\). The query forms that sum by subtracting blocked opponent mass from the total when the subtraction is stable. When the subtraction cancels, including when a blocked opponent dominates a tiny compatible hand, the query adds the compatible hands directly. The same rule covers the showdown win and lose buckets and the posterior marginals used for the node value and for chance weights. A negative residual is not a reach. Structural support stays separate from that floating-point residual. The CFR update arithmetic is unchanged. When \(h\) is structurally supported and \(D_i(h)>0\),

\[
Q_i(h,a)=\sum_g \frac{q_{\mathrm{opp}}(g)}{D_i(h)}\, E[U_i \mid H, B, h, g, \text{force } a, \text{ then follow the average}].
\]

Future cards are dealt from the deck that remains for that fixed pair. Forcing \(a\) does not multiply the result by the average probability of \(a\). A legal action with probability zero still has a continuation value. Later decisions, for both players, follow the average. This is not a best response and it does not maximize future choices.

\(U_i\) is the existing root-centered terminal utility in chips, with \(U_1=-U_0\). The number includes chips already invested. Folding is worth \(-(initial\ pot/2 + that\ player's\ cumulative\ contribution)\). A tie is 0. The stored root EV is player 0's expected utility. At an in-position decision the reported value is the negation of the player-0 amount the terminal kernel stores.

If \(D_i(h)=0\), \(Q_i(h,a)\) is undefined. The query does not invent a uniform opponent range. A hand that is off the board, or otherwise structurally unsupported, is undefined and is not looked up. Hero's own strategic reach can be zero while \(D_i(h)>0\); the counterfactual continuation is still defined. A public node with zero joint reach can still have those hand values. Reach-defined and EV-defined are separate.

The mixed hand value is \(V_i(h)=\sum_a \bar\sigma_i(h,a)\, Q_i(h,a)\).

Where the posterior marginal \(m_i(h)\) exists, the node value is \(\sum_h m_i(h)\, V_i(h)\). At the root this is the stored EV from the actor's side: player 0's utility when OOP acts, and its negation when IP acts. A group's mixed value is the same average over the hands in the group. The group's value for a forced action \(a\) averages \(Q_i(h,a)\) with those same marginals. That is the value of forcing \(a\) for the hands that reach the node. It is not the value conditional on seeing \(a\) played. A group with no posterior mass has a null aggregate even when the individual counterfactual values exist. Those aggregates are not NashConv, cumulative regret, or a best-response gain.
