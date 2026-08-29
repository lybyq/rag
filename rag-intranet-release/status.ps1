<# .SYNOPSIS 查看内网 RAG 容器状态、Bootstrap 结果和最近错误日志。 #>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$composeArgs = @('--env-file', 'images.env', '--env-file', '.env', '-f', 'docker-compose.yml')
docker compose @composeArgs ps
Write-Host "`nBootstrap 最近日志：" -ForegroundColor Cyan
docker compose @composeArgs logs --tail 80 bootstrap
Write-Host "`n未就绪时查看：docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 <服务名>"
