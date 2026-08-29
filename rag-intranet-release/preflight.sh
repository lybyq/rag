#!/usr/bin/env bash
# 校验配置、镜像和外部基础设施；设置 SKIP_CONNECTIVITY=true 可只做静态检查。
set -euo pipefail
cd "$(dirname "$0")"

for file in .env images.env docker-compose.yml; do
  [[ -f "$file" ]] || { echo "缺少文件：$file" >&2; exit 1; }
done

if grep -nE '<[^>]+>|changeme|请填写|todo' .env | grep -vE '^[0-9]+:[[:space:]]*#'; then
  echo '.env 仍有占位符，禁止启动。' >&2
  exit 1
fi

cache_redis="$(sed -nE 's/^REDIS_CACHE_URL=(.*)$/\1/p' .env | tail -n1)"
bullmq_redis="$(sed -nE 's/^REDIS_BULLMQ_URL=(.*)$/\1/p' .env | tail -n1)"
[[ "$cache_redis" != "$bullmq_redis" ]] || {
  echo 'REDIS_CACHE_URL 与 REDIS_BULLMQ_URL 完全相同；必须使用两个独立 Redis。' >&2
  exit 1
}

compose=(docker compose --env-file images.env --env-file .env -f docker-compose.yml)
"${compose[@]}" config --quiet

mapfile -t tags < <(sed -nE 's/^[A-Z0-9_]+=(.+)$/\1/p' images.env)
[[ ${#tags[@]} -eq 6 ]] || { echo 'images.env 必须包含六个镜像变量。' >&2; exit 1; }
for tag in "${tags[@]}"; do
  docker image inspect "$tag" >/dev/null || { echo "本机缺少镜像：$tag" >&2; exit 1; }
done

if [[ "${SKIP_CONNECTIVITY:-false}" != 'true' ]]; then
  echo '检查应用配置以及 PG、两个 Redis、MinIO/S3、Milvus 连通性...'
  "${compose[@]}" run --rm --no-deps platform-api \
    ./node_modules/.bin/tsx scripts/health-check.ts
else
  echo '警告：已跳过外部依赖连通性检查；这不等于具备上线条件。' >&2
fi

echo '发布前检查通过。模型/OCR 契约还需按 provider-http-contracts.md 做真实请求联调。'
