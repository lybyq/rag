<#
.SYNOPSIS
  内网一键启动：可选导入镜像、发布前检查、迁移/建桶、启动六个应用。

.PARAMETER SkipLoad
  镜像已经导入时跳过 docker load；仍会核对 images.env 中的 Tag。

.PARAMETER SkipConnectivity
  跳过外部依赖深度检查，仅供排障。

.PARAMETER WebBind
  覆盖 .env 中 WEB_BIND，例如 8080 或 10.0.0.8:8080。
#>
param(
  [switch]$SkipLoad,
  [switch]$SkipConnectivity,
  [string]$WebBind
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if ($WebBind) { $env:WEB_BIND = $WebBind }
if (-not $SkipLoad) {
  & (Join-Path $PSScriptRoot 'load-images.ps1')
}
& (Join-Path $PSScriptRoot 'preflight.ps1') -SkipConnectivity:$SkipConnectivity

$composeArgs = @('--env-file', 'images.env', '--env-file', '.env', '-f', 'docker-compose.yml')
Write-Host '启动 Bootstrap 和六个应用（禁止 build、禁止 pull）...' -ForegroundColor Cyan
docker compose @composeArgs up -d --no-build --pull never
if ($LASTEXITCODE -ne 0) { throw 'docker compose up 失败。' }

docker compose @composeArgs ps
$bind = if ($WebBind) { $WebBind } else {
  $line = Get-Content -LiteralPath '.env' -Encoding UTF8 |
    Where-Object { $_ -match '^WEB_BIND=' } | Select-Object -Last 1
  if ($line) { ($line -split '=', 2)[1].Trim() } else { '8080' }
}
Write-Host "访问地址：http://<内网服务器IP>:$($bind -replace '^.*:', '')" -ForegroundColor Green
Write-Host '如有容器未就绪：.\status.ps1；重点查看 bootstrap、ingestion-worker 日志。'
