# Agent instructions (poker-solver)

**Before editing code in this repository, read** [`docs/auxiliary/engineering/AGENT_LESSONS.md`](docs/auxiliary/engineering/AGENT_LESSONS.md).

That file is the durable trap list (parallel agents, Study EV/equity lifecycle, locks, configs, Accuracy vs NashConv, AI context packs, Zig cutover). The always-on Cursor rule `.cursor/rules/parallel-agents.mdc` injects a short digest; the full doc wins when they disagree.

Also:

- Do not change `LICENSE` / SPDX (see `.cursor/rules/licensing.mdc`).
- On `zig-rewrite`, the product engine is Zig (`engine/` / `solver-engine`). The C++ `holdem-explorer` / CMake tree is removed — do not reintroduce a C++ shipping path.
- After Study UI / analysis changes: desktop tests + `npx tsc -b`; after assistant/UI label moves: `cd desktop && npm run check:ai-context`.
- After Zig engine changes: `zig build` + `zig build test` (see `.github/workflows/zig.yml`).
- Refresh playbook for this doc: [`docs/auxiliary/engineering/AGENT_LESSONS_REFRESH.md`](docs/auxiliary/engineering/AGENT_LESSONS_REFRESH.md).
