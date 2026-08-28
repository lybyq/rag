#!/usr/bin/env bash
# 内网一键启动脚本（Linux/macOS/Git Bash）。
# 在本目录（rag-intranet-release/）内执行。
set -euo pipefail

cd "$(dirname "$0")"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'
say() { printf '%s\n' "${GREEN}$1${NC}"; }
warn() { printf '%s\n' "${YELLOW}$1${NC}"; }
die() { printf '%s\n' "${RED}$1${NC}" >&2; exit 1; }

# 1. 检查 .env 是否存在。
[ -f .env ] || die "未找到 .env。请先执行: cp .env.example .env 并填写内网地址。"

# 2. 检查是否还有未替换的占位符（跳过注释行与加密密钥默认值）。
if grep -nE '<[^>]+>|请填写|changeme' .env | grep -vE '^\s*[0-9]+:\s*#' | grep -v 'RUN_CONTENT_ENCRYPTION_KEY='; then
  die ".env 中仍有未替换的占位符（<...> / 请填写 / changeme），请全部填写后再启动。"
fi

# 3. 导入镜像。
[ -f rag-apps.tar ] || die "未找到 rag-apps.tar。请先在外网制品机运行 build-release.ps1 生成。"
say "导入镜像 rag-apps.tar ..."
docker load -i rag-apps.tar

# 4. 校验 Compose 配置。
say "校验 docker compose 配置 ..."
docker compose config -q

# 5. 启动（bootstrap 自动迁移 + 建桶，应用等其成功后起）。
say "启动服务 ..."
docker compose up -d

# 6. 状态。
say "容器状态："
docker compose ps

# 7. 访问地址。
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<服务器IP>"
printf '\n'
say "========================================================"
say "启动完成。Web Console 访问地址：http://${IP}:8080"
say "========================================================"
warn "若应用未就绪，查看 bootstrap 日志：docker compose logs bootstrap"
warn "首次启动 bootstrap 需完成 DB 迁移与 MinIO 建桶，请耐心等待。"
