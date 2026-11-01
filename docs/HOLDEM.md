# Hold'em cards, hands, and ranges

52-card deck, seven-card showdown evaluator, and 1,326-hand ranges under `poker::holdem`. This layer does not build a betting tree or run CFR.

## Cards

A card id is `rank * 4 + suit`.

| Rank | Id offset | Suit | Added |
| --- | ---: | --- | ---: |
| 2 | 0 | clubs | 0 |
| 3 | 4 | diamonds | 1 |
| ... | | hearts | 2 |
| A | 48 | spades | 3 |

`Ah` is id 50. Text forms are `Ah`, `td`, and `10h`. Parsing is case-insensitive. A board has 0, 3, 4, or 5 distinct cards. A private hand is two distinct cards that are not on the board. `Deck` starts with all 52 cards; removal is explicit.

## Hand values

`evaluate` takes 5, 6, or 7 distinct cards and returns the best five-card hand. There are 21 five-card subsets of a seven-card hand. Categories, worst to best:

1. High card
2. Pair
3. Two pair
4. Three of a kind
5. Straight
6. Flush
7. Full house
8. Four of a kind
9. Straight flush

An ace-high straight flush is a royal flush. `A-2-3-4-5` is a straight whose tiebreak is the five (rank 3); it loses to a six-high straight and every higher straight. `A-K-2` is not a straight. Suits break a tie only by making a flush or a straight flush. When neither private hand improves the board, the two hands compare equal.

## Combos

There are `C(52, 2) = 1,326` unordered private hands. For card ids `a < b` the index is

```text
a * (103 - a) / 2 + (b - a - 1)
```

`combo_text` prints the higher rank first (`AhKd`).

## Ranges

`Range::parse` reads a comma-separated list. An optional `:weight` is a nonnegative number. The last assignment wins. Supported tokens:

| Token | Hands |
| --- | ---: |
| `AA` | 6 |
| `AKs` | 4 |
| `AKo` | 12 |
| `AK` | 16 |
| `QQ+` | 18 |
| `22-77` | 36 |
| `A2s-A5s` | 16 |
| `ATs+` | 16 |
| `AhKd` or `Ah Kd` | 1 |
| `random` or `*` | 1,326 |

`normalize()` divides by the sum of the weights. An all-zero range stays all zero. `remove_blockers` zeros every combo that uses a dead card. `conditioned` removes those combos and then normalizes (conditional distribution given the dead cards).

JSON is a hand-written array of 1,326 weights in combo-index order. There is no JSON library.

## Joint distribution

Hands are ordered: first component is player 0, second is player 1. A pair `(h0, h1)` is legal when `h0`, `h1`, and the board are pairwise disjoint. The unnormalized mass is

```text
sum w0(h0) w1(h1)
```

over those legal ordered pairs. `joint_distribution` divides each product by that mass. If the mass is zero the result is empty. With both ranges uniform and no board, the mass is `1326 * 1225` (`C(50, 2) = 1225` hands remain after one private hand is removed).
