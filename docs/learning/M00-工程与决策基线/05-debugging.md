# M00 调试手册

## 从用户报障开始

1. 从响应头或错误体取得 `requestId`。
2. 在结构化日志中按 requestId 查询，确认服务名、HTTP 状态、稳定错误码。
3. 有 `traceId` 时打开 Trace，找到耗时最长或报错的 Span。
4. 再看同时间段的请求耗时、错误率和进程资源指标；不要只盯单条日志。
5. Readiness 失败时运行 `pnpm health:deep`，区分网络、凭证、协议和服务状态。

## 示例请求

```powershell
$headers = @{ 'x-request-id' = 'learning-m00-0001' }
Invoke-RestMethod http://localhost:3000/api/v1/health/live -Headers $headers
Invoke-RestMethod http://localhost:3000/api/v1/health/ready -Headers $headers
Invoke-WebRequest http://localhost:3000/api/v1/metrics
```

## 常见误判

- 端口能连不代表服务可用，所以探针执行 SQL、PING、S3 ListBuckets 和 Milvus CheckHealth。
- readiness 503 不等于进程崩溃；先看具体 dependency。
- 前端显示 down 可能只是某个后端进程未启动或 CORS 配置缺少 `5173`。
- Trace 关闭时没有 Trace ID 是预期行为，Request ID 仍必须存在。

更完整的 Docker 故障见 `docs/runbooks/local-development.md`。
