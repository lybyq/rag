param([switch]$BundledMilvus)
$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $bundleRoot 'preflight.ps1')
$arguments = @('compose', '--env-file', (Join-Path $bundleRoot 'images.env'), '--env-file', (Join-Path $bundleRoot 'runtime.env'), '-f', (Join-Path $bundleRoot 'docker-compose.airgap.yml'))
if ($BundledMilvus) { $arguments += @('--profile', 'bundled-milvus') }
$arguments += @('up', '-d', '--wait', '--wait-timeout', '300')
& docker @arguments
if ($LASTEXITCODE -ne 0) { throw '启动失败；请执行 .\status.ps1 查看服务状态和日志。' }
Write-Host 'Enterprise RAG 已启动。'

