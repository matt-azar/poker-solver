# Leduc Hold'em

This is the two-player game from Southey et al., "Bayes' Bluff" (UAI 2005), with the same chip sizes as the default OpenSpiel `leduc_poker` game. It is a multi-street game used to test the shared CFR engine.

## Cards

Six cards, two suits of three ranks:

| Id | Card | Rank |
| --- | --- | --- |
| 0 | J1 | Jack |
| 1 | J2 | Jack |
| 2 | Q1 | Queen |
| 3 | Q2 | Queen |
| 4 | K1 | King |
| 5 | K2 | King |

Rank is `card / 2`. Suit is `card % 2`. A player observes their own card, including which copy it is. The opponent's card is never part of an information set.

Chance deals player 0's card (6 equally likely cards), then player 1's card (5 remaining, equally likely), then, if the first street does not end in a fold, one board card (4 remaining, equally likely).

## Betting

Each player antes 1 before any card is dealt. Player 0 acts first on both streets.

A check is a call of zero chips. An opening bet is the first raise. The default cap is two raises per street, so the longest line is bet, raise, call. A further re-raise is illegal. The cap is configurable separately for each street (`LeducConfig`, or `--max-raises` / `--max-raises-round2`).

Round 1 raise size is 2. Round 2 raise size is 4. The stake level carries over when the board is dealt; it is not reset to the ante.

Examples, with both players' contributions listed as `(player 0, player 1)`:

| Line | Contributions after the line |
| --- | --- |
| Check, check | (1, 1) |
| Bet, fold | (3, 1), player 0 wins the 1 chip ante |
| Bet, call | (3, 3), then the board is dealt |
| Bet, raise, call | (5, 5), then the board is dealt |
| After (3, 3), round-2 bet and call | (7, 7) |

## Showdown

A pair, meaning the private rank equals the board rank, beats a high card. Otherwise the higher rank wins. Equal ranks split the pot. Suits do not break ties. Only one card of the board's rank remains, so at most one player can pair.

Utilities are player 0's net chips. Player 1's payoff is the negation. Folds pay the folder's contribution to the opponent.

## Solver

`LeducGame` implements the same extensive-game operations as Kuhn. `CfrTrainer<LeducGame>` runs vanilla CFR or CFR+. The regret update was not changed for this game. The indexed tree has 936 decision information sets, matching OpenSpiel's two-player count.

There is no closed form used by the solver. Published solves put player 0's equilibrium value near -0.0856. A short run is not that value yet; the tests check that the Nash gap falls, that payoffs sum to zero, and that hidden cards stay out of information sets.
