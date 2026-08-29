<# .SYNOPSIS 停止并移除应用容器/网络，不删除任何外部数据或镜像。 #>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
docker compose --env-file images.env --env-file .env -f docker-compose.yml down --remove-orphans
if ($LASTEXITCODE -ne 0) { throw '停止失败。' }
Write-Host '应用容器与专用网络已移除；外部 PG/Redis/MinIO/Milvus 数据未触碰。' -ForegroundColor Green
