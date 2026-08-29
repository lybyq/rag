#!/usr/bin/env bash
# 停止应用容器，不删除外部数据或镜像。
set -euo pipefail
cd "$(dirname "$0")"
docker compose --env-file images.env --env-file .env -f docker-compose.yml down --remove-orphans
echo '应用容器与专用网络已移除；外部 PG/Redis/MinIO/Milvus 数据未触碰。'
