$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = @('compose', '--env-file', (Join-Path $bundleRoot 'images.env'), '--env-file', (Join-Path $bundleRoot 'runtime.env'), '-f', (Join-Path $bundleRoot 'docker-compose.airgap.yml'))
& docker @base ps
& docker @base logs --tail 80 migrate minio-init platform-api rag-query-service ingestion-worker scheduler-worker document-parser-service web-console

