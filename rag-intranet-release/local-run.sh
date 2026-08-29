#!/usr/bin/env bash
# 在源码仓库运行服务；设置 FORCE_PROFILE=true 才允许覆盖既有 .env.external-dev。
set -euo pipefail
release_root="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$release_root/.." && pwd)"
[[ -f "$release_root/.env" ]] || { echo '请先复制 .env.example 为 .env 并填写。' >&2; exit 1; }
if [[ -f "$repository_root/.env.external-dev" && "${FORCE_PROFILE:-false}" != 'true' ]]; then
  echo '.env.external-dev 已存在；确认后设置 FORCE_PROFILE=true。' >&2
  exit 1
fi
cp "$release_root/.env" "$repository_root/.env.external-dev"

export APP_ENV=development PROVIDER_PROFILE=external-dev AUTH_MODE=mock
export PARSER_BASE_URL=http://127.0.0.1:8104
export PARSER_TEMP_ROOT="$repository_root/.data/parser-runtime"
export CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
mkdir -p "$PARSER_TEMP_ROOT"

cd "$repository_root"
offline_store="$repository_root/.offline/pnpm-store"
[[ -d "$offline_store" ]] || {
  echo '缺少 .offline/pnpm-store；无网源码运行必须把外网准备好的离线依赖 Store 一起带入内网。' >&2
  exit 1
}
# 强制 offline；即使 Registry 或代理误配，也不会在内网尝试访问公网。
pnpm install --frozen-lockfile --offline --store-dir "$offline_store"
pnpm db:migrate
if ! grep -qE '^STORAGE_INIT_ENABLED=false$' "$release_root/.env"; then
  pnpm exec tsx scripts/seed-storage.ts
fi
pnpm health:deep
pnpm dev:services
