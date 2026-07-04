#!/usr/bin/env bash
# Install the TabulaMarkets oracle with the real Google TabFM model.
#
# Usage:
#   scripts/install-oracle.sh              # CPU install
#   scripts/install-oracle.sh --gpu        # CUDA 12.1 install
#   scripts/install-oracle.sh --mock       # skip TabFM (fast dev install)

set -euo pipefail

cd "$(dirname "$0")/../oracle"

MODE="cpu"
for arg in "$@"; do
  case "$arg" in
    --gpu)  MODE="gpu"  ;;
    --mock) MODE="mock" ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Python 3.11+ required.
if ! command -v python3 >/dev/null; then
  echo "python3 not found" >&2; exit 1
fi
PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
  echo "Python 3.11+ required, found ${PY_MAJOR}.${PY_MINOR}" >&2; exit 1
fi

# venv
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip wheel

case "$MODE" in
  mock)
    pip install ".[dev]"
    echo "-- Installed mock-only oracle. Run: TABULA_ORACLE_MOCK=1 tabula-oracle"
    ;;
  cpu)
    # Install CPU torch first so pip resolves the wheel index cleanly.
    pip install "torch>=2.4,<3.0" --index-url https://download.pytorch.org/whl/cpu
    pip install ".[dev,tabfm]"
    echo "-- Installed CPU TabFM. Run: tabula-oracle"
    ;;
  gpu)
    if ! command -v nvidia-smi >/dev/null; then
      echo "nvidia-smi not found — GPU install requires CUDA drivers." >&2; exit 1
    fi
    pip install "torch>=2.4,<3.0" --index-url https://download.pytorch.org/whl/cu121
    pip install ".[dev,tabfm]"
    echo "-- Installed CUDA TabFM. Run: TABFM_DEVICE=cuda tabula-oracle"
    ;;
esac

echo ""
echo "Verify:"
echo "  curl -s http://localhost:8787/model | jq"
