#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle_root"
base=(compose --env-file images.env --env-file runtime.env -f docker-compose.airgap.yml)
docker "${base[@]}" ps
docker "${base[@]}" logs --tail 80 migrate minio-init platform-api rag-query-service ingestion-worker scheduler-worker document-parser-service web-console
