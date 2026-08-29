<#
.SYNOPSIS
  在外网制品机构建、验证并导出 6 个可离线导入的 RAG 应用镜像。

.DESCRIPTION
  应用镜像使用已经锁定摘要的 Node/Nginx 基础镜像，并通过 .offline/pnpm-store 在
  --network=none 条件下安装依赖和编译，以证明内网不需要 npm Registry。最终只导出
  platform-api、rag-query-service、ingestion-worker、scheduler-worker、
  document-parser-service、web-console 六个运行镜像，不夹带 PG/Redis/MinIO/Milvus/模型镜像。

.PARAMETER Version
  业务版本，例如 0.1.0-intranet。最终 Tag 会附加 Git 短 SHA；脏工作区再附加 dirty。

.PARAMETER Platform
  目标 Linux 平台，默认 linux/amd64。

.PARAMETER AllowDirty
  允许从未提交工作区构建。此时 VERSION 和 manifest 会明确记录 dirty=true。

.PARAMETER SkipChecks
  跳过发布质量门禁，仅用于排障，不应交付为正式包。

.PARAMETER ForceArtifacts
  仅覆盖本目录内由本脚本生成的固定产物；不会删除源码、模板或用户 .env。
#>
param(
  [string]$Version = '0.1.0-intranet',
  [string]$Platform = 'linux/amd64',
  [switch]$AllowDirty,
  [switch]$SkipChecks,
  [switch]$ForceArtifacts
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = $PSScriptRoot
$nodeImage = 'node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e'
$nginxImage = 'nginx:1.29.1-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de'

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "缺少必要命令：$Name"
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  Write-Host "`n==> $Description" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Description 失败，退出码：$LASTEXITCODE"
  }
}

Assert-Command docker
Assert-Command git
Assert-Command node
Assert-Command pnpm

Push-Location $repositoryRoot
try {
  $fullSha = (git rev-parse HEAD).Trim()
  $shortSha = (git rev-parse --short=8 HEAD).Trim()
  $status = @(git status --short)
  $dirty = $status.Count -gt 0
  if ($dirty -and -not $AllowDirty) {
    $status | ForEach-Object { Write-Host $_ }
    throw '工作区有未提交内容。提交后重试，或显式使用 -AllowDirty 并接受 dirty 标记。'
  }

  if ($dirty) {
    Write-Warning '正在构建 dirty 制品；manifest 会保留该事实，不能冒充可复现的正式发布。'
  }

  $tagSuffix = "$Version-$shortSha"
  if ($dirty) { $tagSuffix = "$tagSuffix-dirty" }
  $generatedNames = @(
    'rag-apps.tar',
    'images.env',
    'IMAGE-MANIFEST.json',
    'VERSION',
    'SHA256SUMS',
    'provider-http-contracts.md'
  )
  $existingArtifacts = @($generatedNames | Where-Object {
      Test-Path -LiteralPath (Join-Path $releaseRoot $_)
    })
  if ($existingArtifacts.Count -gt 0 -and -not $ForceArtifacts) {
    throw "以下生成物已存在，拒绝覆盖：$($existingArtifacts -join ', ')。确认后使用 -ForceArtifacts。"
  }
  if ($ForceArtifacts) {
    foreach ($name in $generatedNames) {
      $target = Join-Path $releaseRoot $name
      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force
      }
    }
  }

  Write-Host "仓库：$repositoryRoot"
  Write-Host "提交：$fullSha"
  Write-Host "平台：$Platform"
  Write-Host "镜像版本后缀：$tagSuffix"

  if (-not $SkipChecks) {
    Invoke-Checked '安装锁定依赖' { pnpm install --frozen-lockfile }
    # 仓库可能包含用户尚未提交的 UI 格式调整；发布门禁只格式检查本发布包的结构化文件，
    # 其余 correctness 门禁仍覆盖全仓，避免为了出镜像擅自重排不属于本次任务的源码。
    Invoke-Checked '检查发布文档与 Compose 格式' {
      pnpm exec prettier --check rag-intranet-release/README.md rag-intranet-release/docker-compose.yml
    }
    Invoke-Checked '执行全仓 ESLint' { pnpm lint }
    Invoke-Checked '执行全仓 TypeScript/Vue 类型检查' { pnpm typecheck }
    Invoke-Checked '执行架构依赖边界检查' { pnpm boundary }
    Invoke-Checked '执行后端与前端全部单元测试' { pnpm test }
    Invoke-Checked '检查数据库迁移不可变性' { pnpm migration:check }
    Invoke-Checked '审计离线依赖完整性' { pnpm offline:audit }
    Invoke-Checked '编译六个应用' { pnpm build }
    Invoke-Checked '检查 OpenAPI 基线' { pnpm openapi:check }
    Invoke-Checked '检查仓库 Docker Compose 基线' { pnpm docker:check }
  } else {
    Write-Warning '已跳过发布质量门禁；该制品不得作为正式上线包。'
  }

  if (Test-Path -LiteralPath '.offline/pnpm-store') {
    # offline:audit 已在上方按 lockfile 校验内容；复用可避免 pnpm 因 Store 路径变化在无 TTY
    # 制品任务里要求交互确认并尝试重建现有 node_modules。
    Write-Host "`n==> 复用并审计通过的 .offline/pnpm-store" -ForegroundColor Cyan
  } else {
    $previousCi = $env:CI
    try {
      $env:CI = 'true'
      Invoke-Checked '首次准备离线 pnpm Store' {
        pnpm fetch --frozen-lockfile --store-dir .offline/pnpm-store
      }
    } finally {
      if ($null -eq $previousCi) { Remove-Item Env:CI -ErrorAction SilentlyContinue }
      else { $env:CI = $previousCi }
    }
  }
  if (-not (Test-Path -LiteralPath '.offline/pnpm-store')) {
    throw '离线 Store 未生成：.offline/pnpm-store'
  }

  Invoke-Checked '拉取锁定摘要的 Node 基础镜像' { docker pull $nodeImage }
  Invoke-Checked '拉取锁定摘要的 Nginx 基础镜像' { docker pull $nginxImage }

  $builderImage = "enterprise-rag/build/node-pnpm:22.20.0-11.19.0-$shortSha"
  Invoke-Checked "构建离线 Builder $builderImage" {
    docker build --platform $Platform `
      --file deploy/docker/Dockerfile.node-pnpm-builder `
      --build-arg "NODE_IMAGE=$nodeImage" `
      --tag $builderImage .
  }

  $created = [DateTime]::UtcNow.ToString('o')
  $labels = @(
    'org.opencontainers.image.title=Enterprise RAG',
    "org.opencontainers.image.revision=$fullSha",
    "org.opencontainers.image.version=$Version",
    "org.opencontainers.image.created=$created"
  )
  $labelArgs = @()
  foreach ($label in $labels) { $labelArgs += @('--label', $label) }

  $backendApps = @(
    'platform-api',
    'rag-query-service',
    'ingestion-worker',
    'scheduler-worker',
    'document-parser-service'
  )
  $imageTags = @()
  foreach ($appName in $backendApps) {
    $tag = "enterprise-rag/${appName}:$tagSuffix"
    Invoke-Checked "断网构建 $tag" {
      docker build --network=none --platform $Platform `
        --file deploy/docker/Dockerfile.backend.airgap `
        --build-arg "NODE_BUILDER_IMAGE=$builderImage" `
        --build-arg "NODE_RUNTIME_IMAGE=$nodeImage" `
        --build-arg "APP_NAME=$appName" `
        @labelArgs `
        --tag $tag .
    }
    $imageTags += $tag
  }

  $webTag = "enterprise-rag/web-console:$tagSuffix"
  Invoke-Checked "断网构建 $webTag" {
    docker build --network=none --platform $Platform `
      --file deploy/docker/Dockerfile.web.airgap `
      --build-arg "NODE_BUILDER_IMAGE=$builderImage" `
      --build-arg "NGINX_RUNTIME_IMAGE=$nginxImage" `
      @labelArgs `
      --tag $webTag .
  }
  $imageTags += $webTag

  foreach ($tag in $imageTags) {
    Invoke-Checked "检查镜像 $tag" { docker image inspect $tag *> $null }
  }

  $imagesEnvLines = @(
    "PLATFORM_API_IMAGE=$($imageTags[0])",
    "RAG_QUERY_SERVICE_IMAGE=$($imageTags[1])",
    "INGESTION_WORKER_IMAGE=$($imageTags[2])",
    "SCHEDULER_WORKER_IMAGE=$($imageTags[3])",
    "DOCUMENT_PARSER_SERVICE_IMAGE=$($imageTags[4])",
    "WEB_CONSOLE_IMAGE=$($imageTags[5])"
  )
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'images.env'),
    $imagesEnvLines,
    [Text.UTF8Encoding]::new($false)
  )

  $archivePath = Join-Path $releaseRoot 'rag-apps.tar'
  Invoke-Checked '导出 6 个应用镜像到 rag-apps.tar' {
    docker save --output $archivePath $imageTags
  }

  $manifestEntries = foreach ($tag in $imageTags) {
    $inspectJson = docker image inspect $tag | ConvertFrom-Json
    $item = @($inspectJson)[0]
    [pscustomobject]@{
      tag = $tag
      imageId = $item.Id
      sizeBytes = $item.Size
      architecture = $item.Architecture
      os = $item.Os
      repoDigests = @($item.RepoDigests)
    }
  }
  $manifest = [pscustomobject]@{
    releaseName = 'rag-intranet-release'
    version = $Version
    tagSuffix = $tagSuffix
    platform = $Platform
    gitCommit = $fullSha
    gitShortSha = $shortSha
    dirty = $dirty
    qualityGatePassed = (-not $SkipChecks)
    qualityGateFormatScope = @(
      'rag-intranet-release/README.md',
      'rag-intranet-release/docker-compose.yml'
    )
    offlineApplicationBuild = $true
    builtAt = $created
    imageCount = $imageTags.Count
    images = @($manifestEntries)
  }
  [IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'IMAGE-MANIFEST.json'),
    (($manifest | ConvertTo-Json -Depth 6) + "`n"),
    [Text.UTF8Encoding]::new($false)
  )

  $versionLines = @(
    'release=rag-intranet-release',
    "version=$Version",
    "tagSuffix=$tagSuffix",
    "platform=$Platform",
    "gitCommit=$fullSha",
    "dirty=$dirty",
    "qualityGatePassed=$(-not $SkipChecks)",
    'imageCount=6',
    "builtAt=$created"
  )
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'VERSION'),
    $versionLines,
    [Text.UTF8Encoding]::new($false)
  )

  Copy-Item -LiteralPath 'docs/contracts/provider-http-contracts.md' `
    -Destination (Join-Path $releaseRoot 'provider-http-contracts.md')

  $checksumTargets = Get-ChildItem -LiteralPath $releaseRoot -File |
    Where-Object { $_.Name -notin @('SHA256SUMS', '.env') } |
    Sort-Object Name
  $checksumLines = foreach ($file in $checksumTargets) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
  }
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'SHA256SUMS'),
    $checksumLines,
    [Text.UTF8Encoding]::new($false)
  )

  Write-Host "`n发布包已生成：$releaseRoot" -ForegroundColor Green
  Write-Host "镜像归档：$archivePath"
  Write-Host '内网第一步：复制 .env.example 为 .env，填写全部占位符，然后执行 load-images 与 preflight。'
} finally {
  Pop-Location
}
