<#
.SYNOPSIS
  校验配置、六个镜像和外部基础设施连通性；不启动长期服务。

.PARAMETER SkipConnectivity
  只做静态检查。用于尚未打通防火墙时排查配置格式，不代表具备上线条件。
#>
param([switch]$SkipConnectivity)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

foreach ($command in @('docker')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "缺少命令：$command" }
}
foreach ($file in @('.env', 'images.env', 'docker-compose.yml')) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "缺少文件：$file" }
}

$placeholderLines = Select-String -LiteralPath '.env' -Pattern '<[^>]+>|changeme|请填写|todo' |
  Where-Object { $_.Line -notmatch '^\s*#' }
if ($placeholderLines) {
  $placeholderLines | ForEach-Object {
    Write-Host "$($_.LineNumber): $($_.Line.Trim())" -ForegroundColor Yellow
  }
  throw '.env 仍有占位符，禁止启动。'
}

$values = @{}
foreach ($line in Get-Content -LiteralPath '.env' -Encoding UTF8) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
}
if ($values['REDIS_CACHE_URL'] -eq $values['REDIS_BULLMQ_URL']) {
  throw 'REDIS_CACHE_URL 与 REDIS_BULLMQ_URL 完全相同；本部署要求 Cache/BullMQ 使用两个独立 Redis。'
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw '需要 Docker Compose v2（docker compose）。' }

$composeArgs = @('--env-file', 'images.env', '--env-file', '.env', '-f', 'docker-compose.yml')
docker compose @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose 静态配置校验失败。' }

$tags = Get-Content -LiteralPath 'images.env' -Encoding UTF8 |
  Where-Object { $_ -match '^[A-Z0-9_]+=.+$' } |
  ForEach-Object { ($_ -split '=', 2)[1].Trim() }
if (@($tags).Count -ne 6) { throw 'images.env 必须包含六个镜像变量。' }
foreach ($tag in $tags) {
  docker image inspect $tag *> $null
  if ($LASTEXITCODE -ne 0) { throw "本机缺少镜像：$tag；请先执行 .\load-images.ps1。" }
}

if (-not $SkipConnectivity) {
  Write-Host '检查应用配置以及 PG、两个 Redis、MinIO/S3、Milvus 连通性...' -ForegroundColor Cyan
  docker compose @composeArgs run --rm --no-deps platform-api `
    ./node_modules/.bin/tsx scripts/health-check.ts
  if ($LASTEXITCODE -ne 0) { throw '外部基础设施深度健康检查失败。' }
} else {
  Write-Warning '已跳过外部依赖连通性检查；这不等于具备上线条件。'
}

Write-Host '发布前检查通过。模型/OCR 契约还需按 provider-http-contracts.md 做真实请求联调。' -ForegroundColor Green
