#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle_root"
for required in runtime.env images.env docker-compose.airgap.yml; do
  test -f "$required" || { echo "缺少文件：$required" >&2; exit 1; }
done
if grep -E '必须替换|请填写|changeme|registry\.invalid' runtime.env >/dev/null; then
  echo 'runtime.env 仍有占位符，请先完成内网配置。' >&2
  exit 1
fi
docker info >/dev/null
docker compose --env-file images.env --env-file runtime.env -f docker-compose.airgap.yml config --quiet
echo '预检通过。'
