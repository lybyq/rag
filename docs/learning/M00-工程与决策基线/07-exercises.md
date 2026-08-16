# M00 动手练习

## 练习 1：验证配置拒绝启动

设置 `APP_ENV=production`，保留 `.env.example` 默认口令，运行 Platform API。解释为什么错误中只能看到字段名，不能看到值。补一个测试：生产环境带 SSL URL 和非默认密钥时可以通过。

## 练习 2：增加稳定错误码

在 Zod 基础错误码中加入 `CONFLICT`，在异常 Filter 中把 HTTP 409 映射到该码。先写失败测试，再实现；重新生成 OpenAPI，观察 schema diff。

## 练习 3：故障注入

启动全部基础设施后停止 BullMQ Redis。分别记录 liveness、readiness、`pnpm health:deep` 输出和前端状态。回答“为什么进程不应该重启”。

## 练习 4：破坏依赖边界

临时在 `libs/domain` 导入 Milvus SDK，运行 `pnpm boundary`，阅读违规路径后撤销该练习改动。说明只靠代码评审为什么不够。

## 练习 5：追踪一次请求

启动本地 OTel Collector，把 `OTEL_TRACES_ENABLED=true`。发送固定 `x-request-id`，在响应、Pino 日志和 Trace 中找到两个关联 ID，解释它们为何不一定相同。

## 练习 6：前端契约失败

用 MSW 或 fetch stub 返回缺少 `dependencies` 的健康响应，验证 `ServiceHealthEnvelopeSchema` 拒绝它且 UI 不显示绿色。补一条 composable 单测。

## 完成标准

每个练习都保存：命令、预期、实际结果、解释和一条反例。能够不看答案讲清 `Domain → Application → Adapter → App` 的方向后，再进入 M01。
