#!/usr/bin/env bash
# 生成演示项目（合成音频 + 8 段草稿 + 两位校对员，内含 3 处冲突）后启动服务
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m server.seed
exec python3 -m server "${HOST:-127.0.0.1}" "${PORT:-4100}"
