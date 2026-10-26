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
