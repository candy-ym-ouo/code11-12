#!/usr/bin/env bash
# 启动口述听写稿校对台（零依赖，仅需 Python 3.10+）
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4100}"
exec python3 -m server "$HOST" "$PORT"
