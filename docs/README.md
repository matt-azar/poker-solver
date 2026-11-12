# Documentation

Primary docs cover the **CFR+ postflop workflow** and the **Study UI**. Everything else lives under [`auxiliary/`](auxiliary/README.md).

## CFR+ workflow

| Doc | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, `StreetBatchSolver`, CFR+ schedules |
| [STREETS.md](STREETS.md) | Flop / turn / river public tree, config, frozen passes |
| [MATHEMATICS.md](MATHEMATICS.md) | Regret matching, NashConv, EV definitions |
| [HOLDEM.md](HOLDEM.md) | Cards, hand evaluator, ranges |
| [RIVER.md](RIVER.md) | Five-card CLI onto the shared street tree |
| [EQUITY.md](EQUITY.md) | Check-down showdown equity (not chip EV) |

Start with architecture, then streets + mathematics for how a solve runs.

## Study UI

| Doc | Contents |
| --- | --- |
| [DESKTOP_UI.md](DESKTOP_UI.md) | React Study workstation + Windows packaging |
| [EXPLORER.md](EXPLORER.md) | Retired C++ HTTP explorer (historical) |
| [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md) | Floating Study assistant |
| [ai-context/](ai-context/README.md) | Model-facing context packs (imported by the desktop app) |

Product entry: Zig `solver-engine` + `desktop/`. Installer and packaging notes are in DESKTOP_UI. The C++ HTTP explorer doc is historical only.

## Auxiliary

Non-essential material — planning ledgers, engineering notes, optional payoffs, research notes, and archive notes — is under [`auxiliary/`](auxiliary/README.md).

Project archaeology (eras and design decisions): [`auxiliary/notes/PROJECT_HISTORY.md`](auxiliary/notes/PROJECT_HISTORY.md).

Agents: always read [`auxiliary/engineering/AGENT_LESSONS.md`](auxiliary/engineering/AGENT_LESSONS.md) (entry: root [`AGENTS.md`](../AGENTS.md)).
