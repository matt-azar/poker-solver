# Hand history export

`hand-history 1` is a versioned text document for one heads-up played hand. It is the export contract self-play and the trainer will fill later. This is not a Monte-Carlo trainer, pack loader, or session-statistics report.

`format_hand_history` writes one document from a `HandHistoryRecord`. `parse_hand_history` reads it. Formatting a parsed document produces the same text.

## Fields

The first line is `hand-history 1`. Later lines are key/value fields with LF endings.

| Field | Required | Meaning |
| --- | --- | --- |
| `board` | yes | Public board cards, space-separated |
| `pot` | yes | Starting pot (dead money) in chips |
| `stack` | yes | Starting stack behind each player |
| `oop-hole` / `ip-hole` | no | Concrete hole cards. Omit when the export comes from a ranges-only solve |
| `oop-label` / `ip-label` | no | Source-range or study labels when holes are omitted, or as notes |
| `action` | zero or more | `action <player> <canonical label>`; player `0` is OOP, `1` is IP |
| `terminal-pot` | yes | Pot size when the hand ends |
| `outcome` | yes | `showdown` or `fold` |
| `p0-net` | yes | Player 0 net chips from the street start |

Action labels match the engine spelling: `Fold`, `Check`, `Call`, `Bet N`, `Raise to N`, optionally with a trailing ` all-in`.

## Example

Check-down with named holes:

```text
hand-history 1
board Ah Kd 7c 4s 2h
pot 100
stack 200
oop-hole AcAd
ip-hole KsKc
action 0 Check
action 1 Check
terminal-pot 100
outcome showdown
p0-net 50
```

Bet-fold from a ranges-only export (holes omitted, range labels kept):

```text
hand-history 1
board Ah Kd 7c 4s 2h
pot 100
stack 100
oop-label AcAd,5c5d
ip-label KsKc
action 0 Bet 100
action 1 Fold
terminal-pot 200
outcome fold
p0-net 50
```

See [FEATURE_PARITY.md](FEATURE_PARITY.md) and [ROADMAP.md](ROADMAP.md) for M9/M11 status.
