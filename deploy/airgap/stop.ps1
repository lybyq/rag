$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
docker compose --env-file (Join-Path $bundleRoot 'images.env') --env-file (Join-Path $bundleRoot 'runtime.env') -f (Join-Path $bundleRoot 'docker-compose.airgap.yml') down
if ($LASTEXITCODE -ne 0) { throw '停止失败' }
Write-Host '服务已停止；数据目录未删除。'

