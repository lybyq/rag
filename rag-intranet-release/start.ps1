<#
.SYNOPSIS
  内网一键启动脚本（Windows PowerShell）。
  在本目录（rag-intranet-release/）内执行。
#>
param([string]$WebPort)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Say($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

# 1. 检查 .env 是否存在。
if (-not (Test-Path -LiteralPath '.env')) {
  Die '未找到 .env。请先执行: Copy-Item .env.example .env 并填写内网地址。'
}

# 2. 检查是否还有未替换的占位符（跳过注释行与加密密钥默认值）。
$placeholderLines = Select-String -Path '.env' -Pattern '<[^>]+>|请填写|changeme' |
  Where-Object { $_.Line -notmatch '^\s*#' -and $_.Line -notmatch '^RUN_CONTENT_ENCRYPTION_KEY=' }
if ($placeholderLines) {
  Warn '.env 中仍有未替换的占位符：'
  $placeholderLines | ForEach-Object { Warn "  $($_.LineNumber): $($_.Line.Trim())" }
  Die '请全部填写后再启动。'
}

# 3. 导入镜像。
if (-not (Test-Path -LiteralPath 'rag-apps.tar')) {
  Die '未找到 rag-apps.tar。请先在外网制品机运行 build-release.ps1 生成。'
}
Say '导入镜像 rag-apps.tar ...'
docker load -i rag-apps.tar
if ($LASTEXITCODE -ne 0) { Die 'docker load 失败' }

# 4. 校验 Compose 配置。
Say '校验 docker compose 配置 ...'
if ($WebPort) { $env:WEB_PORT = $WebPort }
docker compose config -q
if ($LASTEXITCODE -ne 0) { Die 'docker compose config 校验失败' }

# 5. 启动（bootstrap 自动迁移 + 建桶，应用等其成功后起）。
Say '启动服务 ...'
docker compose up -d
if ($LASTEXITCODE -ne 0) { Die 'docker compose up 失败' }

# 6. 状态。
Say '容器状态：'
docker compose ps

# 7. 访问地址。
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual' } |
  Select-Object -First 1).IPAddress
if (-not $ip) { $ip = '<服务器IP>' }
$port = if ($WebPort) { $WebPort } else { '8080' }
Write-Host ''
Say '========================================================'
Say "启动完成。Web Console 访问地址：http://${ip}:$port"
Say '========================================================'
Warn '若应用未就绪，查看 bootstrap 日志：docker compose logs bootstrap'
Warn '首次启动 bootstrap 需完成 DB 迁移与 MinIO 建桶，请耐心等待。'
