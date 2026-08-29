#!/usr/bin/env bash
# 查看容器状态和 Bootstrap 结果。
set -euo pipefail
cd "$(dirname "$0")"
compose=(docker compose --env-file images.env --env-file .env -f docker-compose.yml)
"${compose[@]}" ps
printf '\nBootstrap 最近日志：\n'
"${compose[@]}" logs --tail 80 bootstrap
echo '未就绪时查看：docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 <服务名>'
