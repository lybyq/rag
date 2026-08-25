#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle_root"
docker compose --env-file images.env --env-file runtime.env -f docker-compose.airgap.yml down
echo '服务已停止；数据目录未删除。'
