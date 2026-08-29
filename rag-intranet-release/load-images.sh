#!/usr/bin/env bash
# 先校验离线包，再导入并核对六个精确镜像 Tag。
set -euo pipefail
cd "$(dirname "$0")"

./verify.sh
[[ -f rag-apps.tar ]] || { echo '缺少 rag-apps.tar。' >&2; exit 1; }
[[ -f images.env ]] || { echo '缺少构建机生成的 images.env。' >&2; exit 1; }

docker load --input rag-apps.tar
mapfile -t tags < <(sed -nE 's/^[A-Z0-9_]+=(.+)$/\1/p' images.env)
[[ ${#tags[@]} -eq 6 ]] || { echo "images.env 应恰好包含 6 个镜像，实际为 ${#tags[@]}。" >&2; exit 1; }
for tag in "${tags[@]}"; do
  docker image inspect "$tag" >/dev/null
  echo "OK  $tag"
done
echo '六个应用镜像已全部导入。'
