$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$archivePath = Join-Path $bundleRoot 'images.tar'
$checksumPath = Join-Path $bundleRoot 'SHA256SUMS.txt'

if (-not (Test-Path -LiteralPath $archivePath)) {
  throw "找不到镜像归档：$archivePath"
}
if (-not (Test-Path -LiteralPath $checksumPath)) {
  throw "找不到校验清单：$checksumPath"
}

$expectedLine = Get-Content -LiteralPath $checksumPath -Encoding utf8 |
  Where-Object { $_ -match '\simages\.tar$' } |
  Select-Object -First 1
if (-not $expectedLine) { throw 'SHA256SUMS.txt 中没有 images.tar' }
$expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "镜像包 SHA-256 不匹配：expected=$expected actual=$actual" }

docker load --input $archivePath
if ($LASTEXITCODE -ne 0) { throw 'docker load 失败' }
Write-Host '镜像导入完成，并已通过 SHA-256 校验。'

