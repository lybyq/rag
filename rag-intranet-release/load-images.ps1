<#
.SYNOPSIS
  先校验离线包，再 docker load，并确认 images.env 中六个精确 Tag 全部存在。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

& (Join-Path $PSScriptRoot 'verify.ps1')
if (-not (Test-Path -LiteralPath 'rag-apps.tar')) { throw '缺少 rag-apps.tar。' }
if (-not (Test-Path -LiteralPath 'images.env')) { throw '缺少构建机生成的 images.env。' }

docker load --input rag-apps.tar
if ($LASTEXITCODE -ne 0) { throw 'docker load 失败。' }

$tags = Get-Content -LiteralPath 'images.env' -Encoding UTF8 |
  Where-Object { $_ -match '^[A-Z0-9_]+=.+$' } |
  ForEach-Object { ($_ -split '=', 2)[1].Trim() }
if (@($tags).Count -ne 6) { throw "images.env 应恰好包含 6 个镜像，实际为 $(@($tags).Count)。" }
foreach ($tag in $tags) {
  docker image inspect $tag *> $null
  if ($LASTEXITCODE -ne 0) { throw "导入后找不到镜像：$tag" }
  Write-Host "OK  $tag"
}
Write-Host '六个应用镜像已全部导入。' -ForegroundColor Green
