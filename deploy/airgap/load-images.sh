#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle_root"
sha256sum --check --ignore-missing SHA256SUMS.txt
docker load --input images.tar
echo '镜像导入完成，并已通过 SHA-256 校验。'
