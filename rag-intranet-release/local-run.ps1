<#
.SYNOPSIS
  在 D 盘源码仓库运行六个进程，并连接 .env 中的内网外部服务。

.PARAMETER ForceProfile
  允许用本目录 .env 覆盖仓库根目录已存在的 .env.external-dev。
#>
param([switch]$ForceProfile)
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeEnv = Join-Path $PSScriptRoot '.env'
$profileEnv = Join-Path $repositoryRoot '.env.external-dev'
if (-not (Test-Path -LiteralPath $runtimeEnv)) { throw '请先复制 .env.example 为 .env 并填写。' }
if ((Test-Path -LiteralPath $profileEnv) -and -not $ForceProfile) {
  throw '.env.external-dev 已存在；为防止覆盖密钥，请先比对，确认后使用 -ForceProfile。'
}
Copy-Item -LiteralPath $runtimeEnv -Destination $profileEnv -Force

$env:APP_ENV = 'development'
$env:PROVIDER_PROFILE = 'external-dev'
$env:AUTH_MODE = 'mock'
$env:PARSER_BASE_URL = 'http://127.0.0.1:8104'
$env:PARSER_TEMP_ROOT = (Join-Path $repositoryRoot '.data/parser-runtime')
$env:CORS_ALLOWED_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'
New-Item -ItemType Directory -Path $env:PARSER_TEMP_ROOT -Force | Out-Null

Push-Location $repositoryRoot
try {
  $offlineStore = Join-Path $repositoryRoot '.offline/pnpm-store'
  if (-not (Test-Path -LiteralPath $offlineStore -PathType Container)) {
    throw '缺少 .offline/pnpm-store；无网源码运行必须把外网准备好的离线依赖 Store 一起带入内网。'
  }
  # 强制 offline，确保误配代理或 Registry 时也不会偷偷访问外网；Store 和 node_modules 都在仓库 D 盘。
  pnpm install --frozen-lockfile --offline --store-dir $offlineStore
  if ($LASTEXITCODE -ne 0) { throw 'pnpm 离线安装失败；请确认 .offline/pnpm-store 与 pnpm-lock.yaml 来自同一次发布。' }
  pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败。' }
  $storageInit = Get-Content -LiteralPath $runtimeEnv -Encoding UTF8 |
    Where-Object { $_ -match '^STORAGE_INIT_ENABLED=' } | Select-Object -Last 1
  if (-not $storageInit -or $storageInit -notmatch '=false$') {
    pnpm exec tsx scripts/seed-storage.ts
    if ($LASTEXITCODE -ne 0) { throw '对象存储建桶失败。' }
  }
  pnpm health:deep
  if ($LASTEXITCODE -ne 0) { throw '基础设施健康检查失败。' }
  pnpm dev:services
} finally {
  Pop-Location
}
