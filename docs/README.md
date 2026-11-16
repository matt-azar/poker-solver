# Documentation

Primary docs cover the **CFR+ postflop workflow** and the **Study UI**. Everything else lives under [`auxiliary/`](auxiliary/README.md).

## CFR+ workflow

| Doc | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Zig modules, storage, Nash gap, stop rule |
| [STREETS.md](STREETS.md) | Flop / turn / river public tree, config, frozen passes |
| [MATHEMATICS.md](MATHEMATICS.md) | Regret matching, NashConv, EV definitions |
| [HOLDEM.md](HOLDEM.md) | Cards, hand evaluator, ranges |
| [RIVER.md](RIVER.md) | Five-card river semantics on the Zig Session |
| [EQUITY.md](EQUITY.md) | Check-down showdown equity (not chip EV) |

Start with architecture, then streets + mathematics for how a solve runs.

## Study UI

| Doc | Contents |
| --- | --- |
| [DESKTOP_UI.md](DESKTOP_UI.md) | React Study workstation + Windows packaging |
| [EXPLORER.md](EXPLORER.md) | `solver-engine` protocol 2 frames |
| [STUDY_SETUP_ASSISTANT.md](STUDY_SETUP_ASSISTANT.md) | Floating Study assistant |
| [ai-context/](ai-context/README.md) | Model-facing context packs (imported by the desktop app) |
| [../desktop/src/demo/README.md](../desktop/src/demo/README.md) | Precomputed public Study demo |
| [../services/river-beta/README.md](../services/river-beta/README.md) | Limited live river browser beta |

Product entry: Zig `solver-engine` and `desktop/`. Installer and packaging notes are in DESKTOP_UI.

## Auxiliary

Non-essential material — planning ledgers, engineering notes, optional payoffs, research notes, and archive notes — is under [`auxiliary/`](auxiliary/README.md).

Project archaeology (eras and design decisions): [`auxiliary/notes/PROJECT_HISTORY.md`](auxiliary/notes/PROJECT_HISTORY.md).

Agents: always read [`auxiliary/engineering/AGENT_LESSONS.md`](auxiliary/engineering/AGENT_LESSONS.md) (entry: root [`AGENTS.md`](../AGENTS.md)).
