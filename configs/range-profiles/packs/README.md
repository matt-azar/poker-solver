# Reliable range packs

## Seat×action pack (preferred)

Source: Matt’s `Ranges.zip` (Google Drive). Copied under `seat-action/` as individual `.txt` weighted charts.

Grain is **position vs action**, not OOP/IP pair files:

| Example file | Meaning |
| --- | --- |
| `CO.txt` | CO open |
| `BBvCOcall.txt` | BB call vs CO open |
| `BBvCO3bet.txt` | BB 3bet vs CO open |
| `COvBB3bcall.txt` | CO call vs BB 3bet |
| `BU.txt` | BTN open |
| `HU2.5.txt` / `HU3bcall200bb.txt` | Heads-up sized/depth variants |

Study setup **composes** atoms (e.g. CO open + BB call → CO vs BB SRP). Desktop loads these via `loadBundledSeatActions()` / `composeSpotFromSeatActions()`.

Classification: `population_estimate` (user-provided). Stack/rake often unspecified in filenames — silence defaults still apply at study level.

## Paired JSON profiles

Schema-v1 paired JSON (legacy/alternate) can still be imported via Build → Range catalogue. Prefer adding new charts as seat×action `.txt` atoms in this folder.

## Synthetic fixtures

Repo-root `fixture-*.json` remain plumbing demos only — not study-quality.
