$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $bundleRoot 'runtime.env'
$images = Join-Path $bundleRoot 'images.env'
$compose = Join-Path $bundleRoot 'docker-compose.airgap.yml'

foreach ($required in @($runtime, $images, $compose)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "缺少文件：$required" }
}

$runtimeText = Get-Content -Raw -LiteralPath $runtime -Encoding utf8
if ($runtimeText -match '必须替换|请填写|changeme|registry\.invalid') {
  throw 'runtime.env 仍有占位符；请填写内网数据库、对象存储、认证、模型和 Milvus 配置。'
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine 不可用' }
docker compose --env-file $images --env-file $runtime -f $compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose 配置校验失败' }
Write-Host '预检通过：环境变量无占位符，Docker 与 Compose 可用。'

