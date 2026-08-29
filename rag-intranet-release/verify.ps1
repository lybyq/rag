<#
.SYNOPSIS
  按 SHA256SUMS 校验离线发布目录，任何文件损坏或缺失都会失败。
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath 'SHA256SUMS')) {
  throw '缺少 SHA256SUMS；请携带完整发布目录。'
}

$failed = $false
foreach ($line in Get-Content -LiteralPath 'SHA256SUMS' -Encoding UTF8) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -notmatch '^([0-9a-fA-F]{64})\s{2}(.+)$') {
    Write-Host "非法校验行：$line" -ForegroundColor Red
    $failed = $true
    continue
  }
  $expected = $Matches[1].ToLowerInvariant()
  $relativePath = $Matches[2]
  if (-not (Test-Path -LiteralPath $relativePath -PathType Leaf)) {
    Write-Host "缺失：$relativePath" -ForegroundColor Red
    $failed = $true
    continue
  }
  $actual = (Get-FileHash -LiteralPath $relativePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Write-Host "摘要不一致：$relativePath" -ForegroundColor Red
    $failed = $true
  } else {
    Write-Host "OK  $relativePath"
  }
}

if ($failed) { throw '发布包完整性校验失败，禁止 docker load 和启动。' }
Write-Host '发布包完整性校验通过。' -ForegroundColor Green
