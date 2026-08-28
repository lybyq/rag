<#
.SYNOPSIS
  构建本项目 6 个应用镜像并导出可带入内网的离线 tar 包（external-dev + Mock 测试包）。

.DESCRIPTION
  在联网、可信、与生产目标同架构的构建机上执行。复用 deploy/docker/Dockerfile.backend 与
  Dockerfile.web，corepack + pnpm install --frozen-lockfile 在镜像内完成依赖安装。
  导出的 rag-apps.tar 只含 6 个应用镜像，不含 PostgreSQL/Redis/MinIO/Milvus/模型镜像。
  产物统一写到仓库根目录 rag-intranet-release/，与 docker-compose.yml/start 脚本同目录。

  镜像 tag 固定为 enterprise-rag/<app>:0.1.0-dev，禁止 latest。

.PARAMETER Version
  镜像版本号，默认 0.1.0-dev。最终 tag 形如 enterprise-rag/<app>:<Version>。

.PARAMETER Platform
  目标平台，默认 linux/amd64。内网主机为 ARM64 时显式传 linux/arm64。

.PARAMETER AllowDirty
  开关。默认拒绝从脏工作区制作包；显式传入时允许，但 manifest 标记 dirty=true。

.PARAMETER SkipChecks
  开关。默认执行 pnpm install --frozen-lockfile 与 pnpm build；跳过时醒目警告。

.EXAMPLE
  ./rag-intranet-release/build-release.ps1
  ./rag-intranet-release/build-release.ps1 -Platform linux/arm64
#>
param(
  [string]$Version = '0.1.0-dev',
  [string]$Platform = 'linux/amd64',
  [switch]$AllowDirty,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseRoot = $PSScriptRoot

# 1. 检查工具链。
function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "缺少必要工具：$Name"
  }
}
Assert-Command 'docker'
Assert-Command 'node'
Assert-Command 'pnpm'

Write-Host "工具链：node $(node -v) / pnpm $(pnpm -v) / docker $(docker --version)"
Write-Host "版本号：$Version  平台：$Platform"
Write-Host "发布目录：$releaseRoot"

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
      throw '拒绝从脏工作区制作包；请先提交，或显式传 -AllowDirty（manifest 将标记 dirty）。'
    }
    Write-Warning '工作区为脏状态（-AllowDirty），manifest 将标记 dirty=true。'
  }

  $archivePath = Join-Path $releaseRoot 'rag-apps.tar'
  if (Test-Path -LiteralPath $archivePath) {
    throw "rag-apps.tar 已存在，拒绝覆盖：$archivePath（删除后再构建）。"
  }

  # 3. 质量门禁。
  if (-not $SkipChecks) {
    Write-Host '执行 pnpm install --frozen-lockfile ...'
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
    Write-Host '执行 pnpm build ...'
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'pnpm build 失败' }
  } else {
    Write-Warning '已跳过质量门禁（-SkipChecks）：未完成 pnpm install 与 pnpm build。'
  }

  # 4. 依次构建 5 个后端镜像 + 1 个 Web 镜像，写入 OCI Label。
  $backendApps = @(
    'platform-api',
    'rag-query-service',
    'ingestion-worker',
    'scheduler-worker',
    'document-parser-service'
  )
  $created = ([DateTime]::UtcNow).ToString('o')
  $labels = @(
    "org.opencontainers.image.source=https://github.com/lybyq/rag",
    "org.opencontainers.image.revision=$fullSha",
    "org.opencontainers.image.version=$Version",
    "org.opencontainers.image.created=$created"
  )

  function Build-Backend {
    param([string]$AppName)
    $tag = "enterprise-rag/${AppName}:$Version"
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
    $tag = "enterprise-rag/web-console:$Version"
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

  # 5. 最小镜像检查。
  foreach ($tag in $imageTags) {
    docker image inspect $tag *> $null
    if ($LASTEXITCODE -ne 0) { throw "镜像检查失败：$tag" }
  }

  # 6. docker save 导出 6 个镜像。
  Write-Host "导出镜像归档：$archivePath"
  docker save --output $archivePath $imageTags
  if ($LASTEXITCODE -ne 0) { throw 'docker save 失败' }

  # 7. 生成 IMAGE-MANIFEST.json。
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
    releaseName = 'rag-intranet-release'
    version = $Version
    platform = $Platform
    gitCommit = $fullSha
    gitShortSha = $shortSha
    dirty = $dirty
    qualityGatePassed = (-not $SkipChecks)
    builtAt = $created
    images = $manifestEntries
  }
  [IO.File]::WriteAllText(
    (Join-Path $releaseRoot 'IMAGE-MANIFEST.json'),
    ($manifest | ConvertTo-Json -Depth 6),
    [Text.UTF8Encoding]::new($false)
  )

  # 8. 生成 VERSION。
  $versionText = @(
    "release=rag-intranet-release",
    "version=$Version",
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

  # 9. 生成 SHA256SUMS（覆盖发布目录所有文件，rag-apps.tar 在内）。
  $checksumTargets = Get-ChildItem -LiteralPath $releaseRoot -File -Recurse |
    Where-Object { $_.Name -ne 'SHA256SUMS' -and $_.Name -ne 'build-release.ps1' } |
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
  Write-Host '镜像列表：'
  foreach ($tag in $imageTags) { Write-Host "  $tag" }
  Write-Host ''
  Write-Host '内网启动命令（在发布包目录内执行）：'
  Write-Host '  docker load -i rag-apps.tar'
  Write-Host '  cp .env.example .env   # 填写内网地址'
  Write-Host '  ./start.sh             # Linux/macOS/Git Bash'
  Write-Host '  .\start.ps1            # Windows PowerShell'
  Write-Host ''
  Write-Host 'SHA256 校验：'
  Write-Host '  Get-Content SHA256SUMS'
} finally {
  Pop-Location
}
