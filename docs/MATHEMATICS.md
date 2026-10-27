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
