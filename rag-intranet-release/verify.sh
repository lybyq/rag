#!/usr/bin/env bash
# 按构建机生成的 SHA256SUMS 校验完整发布包。
set -euo pipefail
cd "$(dirname "$0")"

[[ -f SHA256SUMS ]] || { echo '缺少 SHA256SUMS；请携带完整发布目录。' >&2; exit 1; }
sha256sum --check SHA256SUMS
echo '发布包完整性校验通过。'
