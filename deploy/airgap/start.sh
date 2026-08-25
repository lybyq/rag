#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle_root"
bash preflight.sh
args=(compose --env-file images.env --env-file runtime.env -f docker-compose.airgap.yml)
if [[ "${BUNDLED_MILVUS:-false}" == "true" ]]; then args+=(--profile bundled-milvus); fi
docker "${args[@]}" up -d --wait --wait-timeout 300
echo 'Enterprise RAG 已启动。'
