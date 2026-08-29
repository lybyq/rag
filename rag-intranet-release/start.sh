#!/usr/bin/env bash
# 内网一键启动。SKIP_LOAD=true / SKIP_CONNECTIVITY=true 可用于重复启动和排障。
set -euo pipefail
cd "$(dirname "$0")"

[[ "${SKIP_LOAD:-false}" == 'true' ]] || ./load-images.sh
./preflight.sh

compose=(docker compose --env-file images.env --env-file .env -f docker-compose.yml)
echo '启动 Bootstrap 和六个应用（禁止 build、禁止 pull）...'
"${compose[@]}" up -d --no-build --pull never
"${compose[@]}" ps

web_bind="$(sed -nE 's/^WEB_BIND=(.*)$/\1/p' .env | tail -n1)"
web_bind="${WEB_BIND:-${web_bind:-8080}}"
web_port="${web_bind##*:}"
echo "访问地址：http://<内网服务器IP>:${web_port}"
echo '如有容器未就绪：./status.sh；重点查看 bootstrap、ingestion-worker 日志。'
