#!/usr/bin/env bash
# Bound wall time for gate measurements (Matt: never wait forever on flop trains).
# Usage: run-gate-bounded.sh <seconds> <cmd...>
set -euo pipefail
limit="${1:?usage: run-gate-bounded.sh <seconds> <cmd...>}"
shift
echo "wall_limit_seconds=${limit}" >&2
echo "cmd: $*" >&2
set +e
timeout --signal=TERM --kill-after=10s "${limit}" "$@"
rc=$?
set -e
if [[ "$rc" -eq 124 ]]; then
  echo "BLOCKED: wall limit ${limit}s exceeded; killed runaway measurement" >&2
  exit 124
fi
exit "$rc"
