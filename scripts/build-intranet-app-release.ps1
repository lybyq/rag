<#
.SYNOPSIS
  构建本项目 6 个应用镜像并导出可带入内网的离线 tar 包。

.DESCRIPTION
  在联网、可信、与生产目标同架构的构建机上执行。复用 deploy/docker/Dockerfile.backend
  和 Dockerfile.web，corepack + pnpm install --frozen-lockfile 在镜像内完成依赖安装。
  导出的 tar 只包含 6 个应用镜像，不包含 PostgreSQL、Redis、MinIO、Milvus、etcd 和模型镜像。
  内网导入后只需填写 runtime.env 指向现有服务，不再重新构建镜像或安装 npm 依赖。

.PARAMETER Version
  镜像版本号，默认 0.1.0。最终 tag 形如 enterprise-rag/<app>:<Version>-<short-sha>。

.PARAMETER Platform
  目标平台，默认 linux/amd64。内网主机为 ARM64 时显式传 linux/arm64。

.PARAMETER OutputRoot
  发布目录根，默认 D:\rag-release。发布包写到 <OutputRoot>\enterprise-rag-intranet-apps-<Version>-<short-sha>。

.PARAMETER AllowDirty
  开关。默认拒绝从脏工作区制作正式包；显式传入时允许，但 manifest 标记 dirty=true。

.PARAMETER SkipChecks
  开关。默认执行 pnpm install --frozen-lockfile 与 pnpm check；跳过时醒目警告未完成质量门禁，不得正式交付。

.EXAMPLE
  ./scripts/build-intranet-app-release.ps1 -Version 0.1.0 -Platform linux/amd64 -OutputRoot D:/rag-release
#>
param(
  [string]$Version = '0.1.0',
  [string]$Platform = 'linux/amd64',
  [string]$OutputRoot = 'D:\rag-release',
  [switch]$AllowDirty,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# 1. 检查工具链版本。
function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "缺少必要工具：$Name"
  }
}
Assert-Command 'docker'
Assert-Command 'node'
Assert-Command 'pnpm'

$nodeVersion = (node -v)
$pnpmVersion = (pnpm -v)
Write-Host "工具链：node $nodeVersion / pnpm $pnpmVersion / docker $(docker --version)"

# 2. 记录 commit 与工作区状态；脏工作区默认拒绝。
Push-Location $repositoryRoot
try {
  $fullSha = (git rev-parse HEAD).Trim()
  $shortSha = (git rev-parse --short HEAD).Trim()
  $dirty = $false
  $status = (git status --short)
  if ($status) {
    $dirty = $true
    if (-not $AllowDirty) {
      Write-Host '工作区有未提交修改：'
      Write-Host $status
      throw '拒绝从脏工作区制作正式包；请先提交，或显式传 -AllowDirty（manifest 将标记 dirty）。'
    }
    Write-Warning '工作区为脏状态（-AllowDirty），manifest 将标记 dirty=true；不得作为正式交付。'
  }

  $suffix = if ($dirty) { "$shortSha-dirty" } else { $shortSha }
  $tagSuffix = "$Version-$suffix"
  $releaseName = "enterprise-rag-intranet-apps-$tagSuffix"
  $releaseRoot = Join-Path $OutputRoot $releaseName
  if (Test-Path -LiteralPath $releaseRoot) {
    throw "发布目录已存在，拒绝覆盖：$releaseRoot"
  }
  # 3. 质量门禁。
  if (-not $SkipChecks) {
    Write-Host '执行 pnpm install --frozen-lockfile ...'
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
    Write-Host '执行 pnpm check（质量门禁）...'
    pnpm check
    if ($LASTEXITCODE -ne 0) { throw 'pnpm check 失败' }
  } else {
    Write-Warning '已跳过质量门禁（-SkipChecks）：未完成 pnpm install 与 pnpm check，不得作为正式交付。'
  }

  # 4. 依次构建 5 个后端镜像 + 1 个 Web 镜像，写入 OCI Label。
  $backendApps = @(
    'platform-api',
    'rag-query-service',
    'ingestion-worker',
    'scheduler-worker',
    'document-parser-service'
  )
  $created = (Get-Date -AsUTC).ToString('o')
  $labels = @(
    "org.opencontainers.image.source=https://github.com/lybyq/rag",
    "org.opencontainers.image.revision=$fullSha",
    "org.opencontainers.image.version=$Version",
    "org.opencontainers.image.created=$created"
  )

  function Build-Backend {
    param([string]$AppName)
    $tag = "enterprise-rag/${AppName}:$tagSuffix"
    $labelArgs = $labels | ForEach-Object { '--label'; $_ }
    Write-Host "构建后端镜像：$tag ($Platform)"
    docker build --platform $Platform `
      --file deploy/docker/Dockerfile.backend `
      --build-arg "APP_NAME=$AppName" `
      @labelArgs `
      --tag $tag .
    if ($LASTEXITCODE -ne 0) { throw "构建应用镜像失败：$AppName" }
    return $tag
  }

  function Build-Web {
    $tag = "enterprise-rag/web-console:$tagSuffix"
    $labelArgs = $labels | ForEach-Object { '--label'; $_ }
    Write-Host "构建 Web 镜像：$tag ($Platform)"
    docker build --platform $Platform `
      --file deploy/docker/Dockerfile.web `
      @labelArgs `
      --tag $tag .
    if ($LASTEXITCODE -ne 0) { throw '构建 Web 镜像失败' }
    return $tag
  }

  $imageTags = @()
  foreach ($appName in $backendApps) { $imageTags += (Build-Backend -AppName $appName) }
  $imageTags += (Build-Web)

  # 5. 最小镜像检查：每个 tag 可 inspect。
  foreach ($tag in $imageTags) {
    docker image inspect $tag *> $null
    if ($LASTEXITCODE -ne 0) { throw "镜像检查失败：$tag" }
  }

  # 6. 建发布目录、docker save、复制交付文件。
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  $imagesDir = Join-Path $releaseRoot 'images'
  New-Item -ItemType Directory -Path $imagesDir -Force | Out-Null
  $archiveName = "enterprise-rag-apps-$tagSuffix.tar"
  $archivePath = Join-Path $imagesDir $archiveName
  Write-Host "导出镜像归档：$archivePath"
  docker save --output $archivePath $imageTags
  if ($LASTEXITCODE -ne 0) { throw 'docker save 失败' }

  Copy-Item -LiteralPath intranet/docker-compose.yml -Destination $releaseRoot
  Copy-Item -LiteralPath intranet/runtime.env.example -Destination $releaseRoot
  Copy-Item -LiteralPath intranet/images.env.example -Destination $releaseRoot
  Copy-Item -LiteralPath intranet/README.md -Destination $releaseRoot

  # 7. 生成 images.env（用实际 tagSuffix 替换占位）。
  $imagesEnv = Get-Content -Raw -Encoding utf8 intranet/images.env.example
  $imagesEnv = $imagesEnv.Replace('<version>-<short-sha>', $tagSuffix)
  [IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'images.env'),
    $imagesEnv,
    [Text.UTF8Encoding]::new($false)
  )

  # 8. 生成 IMAGE-MANIFEST.json。
  $manifestEntries = @()
  foreach ($tag in $imageTags) {
    $inspect = docker image inspect $tag --format '{{.Id}}|{{.Architecture}}|{{.Os}}|{{json .RepoDigests}}|{{json .Config.Labels}}'
    $parts = $inspect -split '\|', 5
    $name = ($tag -split ':')[0]
    $manifestEntries += [pscustomobject]@{
      image = $name
      tag = $tag
      imageId = $parts[0]
      architecture = $parts[1]
      os = $parts[2]
      repoDigests = if ($parts[3] -ne '<nil>') { $parts[3] | ConvertFrom-Json } else { @() }
      platform = $Platform
      builtAt = $created
      gitCommit = $fullSha
      gitShortSha = $shortSha
      dockerfile = if ($name -eq 'enterprise-rag/web-console') {
        'deploy/docker/Dockerfile.web'
      } else {
        'deploy/docker/Dockerfile.backend'
      }
      dirty = $dirty
      qualityGatePassed = (-not $SkipChecks)
    }
  }
  $manifest = [pscustomobject]@{
    releaseName = $releaseName
    version = $Version
    tagSuffix = $tagSuffix
    platform = $Platform
    gitCommit = $fullSha
    gitShortSha = $shortSha
    dirty = $dirty
    qualityGatePassed = (-not $SkipChecks)
    builtAt = $created
    images = $manifestEntries
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'IMAGE-MANIFEST.json'),
    $manifestJson,
    [Text.UTF8Encoding]::new($false)
  )

  # 9. 生成 VERSION。
  $versionText = @(
    "release=$releaseName",
    "version=$Version",
    "tagSuffix=$tagSuffix",
    "platform=$Platform",
    "gitCommit=$fullSha",
    "gitShortSha=$shortSha",
    "dirty=$dirty",
    "qualityGatePassed=$(-not $SkipChecks)",
    "builtAt=$created"
  ) -join "`n"
  [IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'VERSION'),
    "$versionText`n",
    [Text.UTF8Encoding]::new($false)
  )

  # 10. 生成 SHA256SUMS（递归覆盖发布目录所有文件）。
  $checksumTargets = Get-ChildItem -LiteralPath $releaseRoot -File -Recurse |
    Where-Object { $_.Name -ne 'SHA256SUMS' } |
    Sort-Object FullName
  $checksumLines = foreach ($file in $checksumTargets) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relativePath = $file.FullName.Substring($releaseRoot.Length + 1).Replace('\', '/')
    "$hash  $relativePath"
  }
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'SHA256SUMS'),
    $checksumLines,
    [Text.UTF8Encoding]::new($false)
  )

  Write-Host ''
  Write-Host '========================================================' -ForegroundColor Green
  Write-Host "离线发布包已生成：$releaseRoot" -ForegroundColor Green
  Write-Host '========================================================' -ForegroundColor Green
  Write-Host ''
  Write-Host '内网导入与启动命令（在发布包目录内执行）：'
  Write-Host '  # 1. 校验与导入'
  Write-Host "  sha256sum -c SHA256SUMS    # Windows: Get-FileHash 逐项比对"
  Write-Host "  docker load --input images/$archiveName"
  Write-Host '  docker image ls | grep enterprise-rag'
  Write-Host '  # 2. 填写配置'
  Write-Host '  cp runtime.env.example runtime.env'
  Write-Host '  #    编辑 runtime.env，替换所有 <...> 占位符'
  Write-Host '  cp images.env images.env  # 已含实际 tag，无需再改'
  Write-Host '  # 3. 校验、迁移、建桶、启动'
  Write-Host '  export RAG_ENV_FILE="$(pwd)/runtime.env"'
  Write-Host '  docker compose --env-file images.env -f docker-compose.yml config --quiet'
  Write-Host '  docker compose --env-file images.env -f docker-compose.yml run --rm migrate'
  Write-Host '  docker compose --env-file images.env -f docker-compose.yml --profile init run --rm storage-init'
  Write-Host '  docker compose --env-file images.env -f docker-compose.yml up -d'
  Write-Host '  docker compose --env-file images.env -f docker-compose.yml ps'
  Write-Host ''
  Write-Host '详细步骤见 docs/runbooks/intranet-existing-services-deployment.md。'
} finally {
  Pop-Location
}
