# Lessons for future agents

Operational mistakes and friction observed while multiple Cursor agents worked this repository in parallel (cloud parent plus delegated Task / best-of-n runners). Read this before spawning sibling agents or merging their output.

## Hard rules (parallel work)

1. **One writer per tree.** Assume delegated agents may write into the shared `/workspace` even when told to use an isolated worktree. Do not `git checkout`, reset, or commit on `/workspace` while siblings are still running unless you have confirmed they use a separate path and never touch `/workspace`.
2. **Do not overlap file ownership.** Assign disjoint path prefixes per agent (e.g. one owns `tests/unit/test_explorer_http.cpp`, another owns `include/solver/payoff.hpp`). If two tracks need the same file, serialize them or let only the parent edit that file.
3. **Parent owns forge writes.** Subagents often lack `ManagePullRequest` (and must not use `gh` for PR create/update). The parent opens/updates PRs after the branch is pushed.
4. **Snapshot before splitting.** If the working tree is interleaved, commit everything onto a throwaway `cursor/wip-…-c006` branch first, then check out clean feature branches from `origin/main` (or the intended base) and path-checkout only the files that belong on each branch.
5. **Re-check `git status` before every commit.** Sibling agents keep writing after you think you have a clean index. Restore unexpected paths with `git checkout HEAD -- <path>` before `git add`.
6. **Keep CMake / test harness edits scoped.** A shared `CMakeLists.txt` or `tests/unit/test_main.cpp` from a WIP snapshot will list every agent’s sources. Edit the list down to this branch’s targets only or the build breaks.

## What went wrong

### Shared workspace pollution

Delegated “isolated” runners still left diffs in the parent `/workspace`: new headers, partial `explorer_main.cpp` rewrites, UI edits, and test harness hooks from unrelated milestones appeared on whichever branch the parent had checked out. Symptoms:

- `git status` gains files you did not touch mid-turn.
- Builds fail with missing includes (e.g. `hand_categories.hpp` referenced from a file an agent patched while you were on a branch that does not have that header).
- Assertion counts and SKIP lines flip between runs without a local commit.

**Mitigation:** treat `/workspace` as contended. Prefer finishing one track yourself, or wait for background agents to finish and then integrate. If you must parallelize, use true separate worktree paths and verify with `git worktree list` / agent-reported paths before editing.

### Interleaved features on one tree

Hand categories (M2), dual-player payoff (M8), Linux explorer HTTP, and explorer five-card routing landed as one mixed dirty tree. A single `CMakeLists.txt` referenced both `hand_categories.cpp` and `test_payoff.cpp` while only one feature’s sources existed on the branch.

**Mitigation:** WIP snapshot commit → per-feature branch → path-limited `git checkout <wip> -- <files>` → fix CMake/harness/docs to match → build/test → push → parent opens PR.

### Parent and agent duplicating the same branch

The parent started `cursor/payoff-dual-utility-c006` locally while a subagent also targeted that name. The agent pushed first; the parent’s later commit attempt looked “ahead by 1” with confusing staged/unstaged noise.

**Mitigation:** either the parent implements a track **or** a subagent does—not both. If the agent owns the branch, the parent only opens the PR and watches CI.

### Subagent cannot open the PR

Payoff, Linux HTTP, explorer-street, and related runners reported success and a pushed branch but **no PR**, because `ManagePullRequest` was unavailable in the subagent session. Without parent follow-up, work sits on a remote branch only.

**Mitigation:** parent checklist after each agent completion: branch on origin? PR open? CI subscribed? If the agent pasted a compare URL, open the PR immediately.

### Docs and parity rows from the wrong milestone

A WIP `FEATURE_PARITY.md` / `ROADMAP.md` checkout pulled M8 payoff wording onto an M2 hand-categories branch (and the reverse risk exists).

**Mitigation:** for doc updates, start from `origin/main`’s copy of the doc and apply only this milestone’s row edits. Do not path-checkout whole docs from a multi-feature WIP commit.

### Base-branch mistakes for stacked work

Explorer five-card routing must sit on five-card StreetBatch acceptance. Building explorer routing on plain `main` without those commits breaks five-card construction.

**Mitigation:** state the required base in the agent prompt (`origin/cursor/street-five-card-c006`). Prefer one PR that includes the dependency commits when targeting `main`, or set `base_branch` to the dependency branch and say so in the PR body.

### CI subscriptions and noise

Multiple `github:ci:branch` subscriptions on finished green branches continue to deliver. Unsubscribe when the outcome is known if you need a quieter queue. Subscribe to each new PR head after push.

## What worked

- **Disjoint ambitious tracks** (payoff abstraction, Linux HTTP coverage, hand categories, explorer five-card join) when file ownership stayed separate and the parent integrated.
- **WIP snapshot branch** as a recovery tool when pollution already happened.
- **Parent-owned PRs** plus CI subscriptions after subagent push.
- **Explicit out-of-scope lists** in agent prompts (reduced but did not eliminate cross-edits).
- **Local full `poker_solver_tests`** before push; Linux HTTP must not print `SKIP explorer HTTP tests`.

## Suggested agent prompt clauses

When spawning a sibling:

```text
Work only under this worktree path: <absolute path>.
Do not modify /workspace.
Touch only these paths: <list>.
Do not edit CMakeLists.txt, tests/harness.hpp, or tests/unit/test_main.cpp
  unless your path list includes them; if you must, add only your targets.
Branch: cursor/<name>-c006 from <exact base ref>.
Push with git push -u origin <branch>.
Do not open a PR (parent will ManagePullRequest).
Do not change LICENSE.
Report: branch tip SHA, files touched, test command + counts, compare URL.
```

## Recovery checklist (interleaved tree)

1. `git status` / `git diff --stat` — inventory every path.
2. `git checkout -B cursor/wip-<topic>-c006` and commit all dirty + untracked WIP.
3. For each feature: `git checkout -B cursor/<feature>-c006 origin/main` (or dependency base).
4. `git checkout cursor/wip-… -- <only that feature’s files>`.
5. Trim `CMakeLists.txt`, `test_main.cpp`, `harness.hpp`, and docs to that feature.
6. `CXX=g++` configure/build; run `poker_solver_tests`; fix.
7. Push; parent creates PR; subscribe CI.
8. Leave the WIP branch unmerged for archaeology; delete when all splits are pushed.

## Repo-specific reminders

- Cloud branches: `cursor/<descriptive-name>-c006`, lowercase.
- Prefer `base_branch=main` unless stacking on an unmerged dependency.
- Licensing: see `.cursor/rules/licensing.mdc` — do not change `LICENSE`.
- Explorer HTTP was historically Windows-only; Linux coverage is a real CI gap when SKIP returns.
- Five-card production join: StreetBatch acceptance and explorer routing are separate slices; do not drop `river_solver` until pins and explorer routing are both done.
