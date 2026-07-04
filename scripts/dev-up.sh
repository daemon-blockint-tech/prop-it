#!/usr/bin/env bash
# Local dev bootstrap: start the oracle, keeper simulator, and frontend
# in three background jobs so `npm run dev` all-in-one works.
#
# Requires: python3, node >=20, an active oracle venv or TABULA_ORACLE_MOCK=1.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"

echo "▶ oracle  ($root/oracle)"
( cd "$root/oracle" && TABULA_ORACLE_MOCK=${TABULA_ORACLE_MOCK:-1} \
    python3 -m uvicorn tabula_oracle.server:app --port 8787 ) &
oracle_pid=$!

sleep 2

echo "▶ keeper  ($root/keeper)"
( cd "$root/keeper" && npm run simulate ) &
keeper_pid=$!

echo "▶ frontend  ($root/app)"
( cd "$root/app" && npm run dev ) &
front_pid=$!

trap 'kill $oracle_pid $keeper_pid $front_pid 2>/dev/null || true' INT TERM EXIT
wait
