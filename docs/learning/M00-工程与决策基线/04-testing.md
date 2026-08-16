# M00 测试与门禁

## 测试金字塔

Unit 测试不启动 Docker，快速证明配置和健康聚合规则。Contract 测试使用 Zod 验证跨端结构。Integration 测试连接真实 PostgreSQL、Redis、MinIO 和 Milvus，证明“SDK 能通信”而不是“Mock 返回成功”。Vue 使用 Vitest + Vue Test Utils。

## 运行

```powershell
pnpm test
pnpm test:contract
pnpm dev:infra
$env:RUN_INTEGRATION_TESTS='true'; pnpm test:integration
pnpm check
```

## 失败注入练习

1. 停止 `redis-bullmq`，访问 readiness，应为 503 且只有该依赖为 down。
2. liveness 仍应为 200，证明外部抖动不会触发重启风暴。
3. 把 `APP_ENV=production` 且保留默认密码，四个进程都应在监听端口前失败。
4. 修改 Zod 健康字段但不更新前端，前端应显示协议解析失败而不是错误绿灯。

## CI 门禁含义

`format/lint/typecheck` 控制局部质量；`boundary` 控制架构方向；`unit/contract/integration` 控制行为；`migration/schema diff` 控制数据和接口兼容；Trivy 与 audit 控制已知漏洞；SBOM 让部署物可追溯。任何单项都不能替代其他项。
