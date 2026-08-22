# M06 验收清单

## A. 自动化功能门禁

- [x] Conversation、Message、ConversationState、Run、Step、Outbox 和 Feedback 数据模型。
- [x] 同用户 Idempotency-Key 并发创建稳定重放；同键不同请求冲突。
- [x] 创建快速返回 202 ACCEPTED 和事件/Ticket 地址，不同步调用模型。
- [x] 冻结流程、策略、Prompt、Validator、Provider、Manifest 和授权版本。
- [x] 状态机、乐观锁、Deadline、CANCELLING 和终态不可逆。
- [x] Step 仅保存有限摘要、耗时、稳定错误和 Trace。
- [x] PG sequence Outbox → Redis Stream 严格顺序、幂等重投和 TTL。
- [x] 认证 SSE 与绑定 runId+userId 的一次性 Ticket。
- [x] Last-Event-ID、heartbeat、慢客户端 drain、ETag 和 PG 降级。
- [x] 本地与跨实例取消协议提供标准 AbortSignal。
- [x] 最终答案、Run 终态和 answer.completed Outbox 同事务。
- [x] 短窗口、摘要、实体、引用和历史来源重新鉴权。
- [x] Run/Conversation/Event/Cancel/Ticket/Feedback API 与 OpenAPI。
- [x] AES-256-GCM、REDACTED、生产明文门禁和保留期清理。

## B. 工程门禁

- [x] Domain 不依赖 NestJS/PG/Redis；Application 只依赖 Port。
- [x] Controller 只做可信身份、Zod 输入与输出映射。
- [x] 源文件中文 JSDoc、需求编号和 M06 七章学习资料齐全。
- [x] 单元测试覆盖状态机、取消、AES 篡改和 Redis 部分失败。
- [x] 真实 PostgreSQL+Redis 覆盖并发幂等、序号、Ticket、事务答案、撤权和清理。
- [x] 最终 format、lint、strict typecheck、boundary、backend test、build、OpenAPI、Migration、Compose 全部门禁。

## C. 内网环境门禁

- [ ] Secret 注入独立 AES-256-GCM 密钥，确认备份、恢复与轮换流程。
- [ ] 两个以上副本验证跨实例 AbortSignal 取消。
- [ ] 企业 Redis 故障切换、Stream 淘汰/恢复和容量阈值。
- [ ] Ingress SSE 缓冲、heartbeat、idle timeout 和连接上限。
- [ ] 按合规要求确认问题/答案保留期和清理审计。
- [ ] 中型规模慢客户端、断网重连、并发幂等与 8 小时 soak。

## D. 复验命令

```powershell
$env:TEMP='D:\coding\rag\.tmp'
$env:TMP='D:\coding\rag\.tmp'
pnpm db:migrate
pnpm test:backend
pnpm test:integration
pnpm format:check
pnpm lint
pnpm typecheck
pnpm boundary
pnpm build
pnpm openapi:check
pnpm migration:check
pnpm docker:check
```

若 C 盘空间不足，不启动会继续向 C 盘写镜像层的 Docker 工作负载；使用 D 盘 TEMP/TMP，并先将 Docker data-root 迁移到 D 盘后再做内网镜像/负载复验。
