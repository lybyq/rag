param(
  [string]$OutputRoot = 'D:\rag-artifacts',
  [string]$ReleaseVersion = '0.1.0-airgap'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$releaseName = "enterprise-rag-airgap-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$releaseRoot = Join-Path $OutputRoot $releaseName
if (Test-Path -LiteralPath $releaseRoot) {
  throw "输出目录已经存在，拒绝覆盖：$releaseRoot"
}
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$nodeImage = 'docker.m.daocloud.io/library/node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e'
$nginxImage = 'docker.m.daocloud.io/library/nginx@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de'
$backendApps = @(
  'platform-api',
  'rag-query-service',
  'ingestion-worker',
  'scheduler-worker',
  'document-parser-service'
)

Push-Location $repositoryRoot
try {
  # 应用镜像必须在外网构建机完成；内网发布包只携带运行时层，不要求 npm 或 pnpm。
  docker pull $nodeImage
  if ($LASTEXITCODE -ne 0) { throw '拉取锁定 Node 基础镜像失败' }
  docker pull $nginxImage
  if ($LASTEXITCODE -ne 0) { throw '拉取锁定 Nginx 基础镜像失败' }

  if (-not (Test-Path -LiteralPath '.offline/pnpm-store')) {
    throw '缺少 .offline/pnpm-store；请先在 D 盘执行 pnpm offline:prepare'
  }
  $builderImage = "enterprise-rag/build/node-pnpm:22.20.0-11.19.0"
  docker build --file deploy/docker/Dockerfile.node-pnpm-builder `
    --build-arg "NODE_IMAGE=$nodeImage" `
    --tag $builderImage .
  if ($LASTEXITCODE -ne 0) { throw '构建 Node/pnpm Builder 镜像失败' }

  foreach ($appName in $backendApps) {
    $tag = "enterprise-rag/${appName}:$ReleaseVersion"
    docker build --network=none --file deploy/docker/Dockerfile.backend.airgap `
      --build-arg "NODE_BUILDER_IMAGE=$builderImage" `
      --build-arg "NODE_RUNTIME_IMAGE=$nodeImage" `
      --build-arg "APP_NAME=$appName" `
      --tag $tag .
    if ($LASTEXITCODE -ne 0) { throw "构建应用镜像失败：$appName" }
  }
  docker build --network=none --file deploy/docker/Dockerfile.web.airgap `
    --build-arg "NODE_BUILDER_IMAGE=$builderImage" `
    --build-arg "NGINX_RUNTIME_IMAGE=$nginxImage" `
    --tag "enterprise-rag/web-console:$ReleaseVersion" .
  if ($LASTEXITCODE -ne 0) { throw '构建 Web 镜像失败' }

  # 供应商镜像重打本包私有版本 Tag，docker save 后不依赖外部仓库名称或网络。
  $vendorTags = [ordered]@{
    'postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94' = 'enterprise-rag/vendor/postgres:17.6'
    'redis@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232' = 'enterprise-rag/vendor/redis:8.2.1'
    'docker.m.daocloud.io/minio/minio@sha256:391d1d45fdbe79944cb6de9337b073864bb9ee38c4c24280bfb39572e925af08' = 'enterprise-rag/vendor/minio:2024-05-28'
    'quay.io/coreos/etcd@sha256:d0a641d5fbcc89678c931a61b7de7b8a1cf097149f135c9c73bc81d076a1494b' = 'enterprise-rag/vendor/etcd:3.5.18'
    'docker.m.daocloud.io/milvusdb/milvus@sha256:27f1732a6668c813ee96d21364e3ba220ce1dd1d6e07660106d646dc33d1c654' = 'enterprise-rag/vendor/milvus:2.6.4'
  }
  foreach ($source in $vendorTags.Keys) {
    docker image inspect $source *> $null
    if ($LASTEXITCODE -ne 0) { throw "本机缺少已锁定供应商镜像：$source" }
    docker tag $source $vendorTags[$source]
  }

  Copy-Item -LiteralPath deploy/airgap/docker-compose.airgap.yml -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/runtime.env.example -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/load-images.ps1 -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/preflight.ps1 -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/start.ps1 -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/status.ps1 -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/stop.ps1 -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/load-images.sh -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/preflight.sh -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/start.sh -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/status.sh -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/stop.sh -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/airgap/README.md -Destination $releaseRoot
  Copy-Item -LiteralPath deploy/docker/postgres/init -Destination (Join-Path $releaseRoot 'postgres-init') -Recurse

  $docsRoot = Join-Path $releaseRoot 'docs'
  New-Item -ItemType Directory -Path $docsRoot -Force | Out-Null
  Copy-Item -LiteralPath docs/contracts/provider-http-contracts.md -Destination $docsRoot
  Copy-Item -LiteralPath 'docs/learning/企业级RAG完整学习手册' -Destination (Join-Path $docsRoot '企业级RAG完整学习手册') -Recurse
  Copy-Item -LiteralPath docs/runbooks/backup-restore.md -Destination $docsRoot

  $imageTags = @(
    ($backendApps | ForEach-Object { "enterprise-rag/${_}:$ReleaseVersion" })
    "enterprise-rag/web-console:$ReleaseVersion"
    $vendorTags.Values
  )
  $imageTags = @($imageTags | ForEach-Object { $_ })
  $archivePath = Join-Path $releaseRoot 'images.tar'
  docker save --output $archivePath $imageTags
  if ($LASTEXITCODE -ne 0) { throw 'docker save 失败' }

  $imagesEnv = Get-Content -Raw -Encoding utf8 deploy/airgap/images.env.example
  $imagesEnv = $imagesEnv.Replace('0.1.0-airgap', $ReleaseVersion)
  [IO.File]::WriteAllText((Join-Path $releaseRoot 'images.env'), $imagesEnv, [Text.UTF8Encoding]::new($false))

  $manifestLines = foreach ($tag in $imageTags) {
    $inspect = docker image inspect $tag --format '{{.Id}}|{{.Size}}|{{json .RepoDigests}}'
    "$tag|$inspect"
  }
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'IMAGE_MANIFEST.txt'),
    $manifestLines,
    [Text.UTF8Encoding]::new($false)
  )

  # 对离线包内所有文件递归计算摘要，避免脚本、文档或数据库初始化文件被遗漏。
  $checksumTargets = Get-ChildItem -LiteralPath $releaseRoot -File -Recurse |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    Sort-Object FullName
  $checksumLines = foreach ($file in $checksumTargets) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relativePath = $file.FullName.Substring($releaseRoot.Length + 1).Replace('\\', '/')
    "$hash  $relativePath"
  }
  [IO.File]::WriteAllLines(
    (Join-Path $releaseRoot 'SHA256SUMS.txt'),
    $checksumLines,
    [Text.UTF8Encoding]::new($false)
  )
  Write-Host "离线发布包已生成：$releaseRoot"
} finally {
  Pop-Location
}
