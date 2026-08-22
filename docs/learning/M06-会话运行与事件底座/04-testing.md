# M06 测试：证明竞态和故障，不只证明 Happy Path

## 单元门禁

- `rag-run-state.spec.ts`：终态不可逆，CANCELLING 禁止晚到 COMPLETED，Step 迁移合法性。
- `rag-run-cancellation.spec.ts`：同 Run 共享 Signal、取消幂等、终态释放。
- `rag-run-event-publisher.service.spec.ts`：Redis 单条失败会释放租约，其他事件继续发布。
- `aes-gcm-sensitive-text.protector.spec.ts`：随机 IV、篡改 fail-closed、Hash 校验、REDACTED。
- `rag-run.spec.ts`：公共契约的正常与非法输入。

## 真实 PG + Redis 集成门禁

`test/integration/m06-conversation-run.integration.spec.ts` 不用内存仓库替代核心一致性：

1. 8 个并发同 key 请求，断言只有 1 个 Run、1 条用户消息和 1 个非 replay 响应。
2. 完整运行 start → step start → step finish → complete，查询答案消息与完成 Outbox 的 messageId 一致。
3. 发布后 Redis sequence 必须严格为 1、2、3、4、5，事件类型顺序一致。
4. Ticket 首次兑换成功，第二次返回 NOT_FOUND。
5. AES 密文列不包含合成答案原文；Application 能正确解密。
6. 会话摘要写入带版本；模拟撤权后答案和摘要均 fail-closed。
7. 取消立即让 Signal aborted，随后确认 CANCELLED；其他用户读取得到统一 404。
8. 极早 Deadline 和保留期由维护器各领取一条，Run 进入 EXPIRED，正文变 REDACTED 但 SHA-256 保留。

## 为什么维护测试使用 1900 年和 limit=1

集成库可能与开发数据共用。测试把自己的记录设为远早于普通数据，并限制只领取一条，确保维护器不会顺手修改其他到期记录。清理函数按外键逆序、按精确 conversation/space 删除，Redis 也只删测试 Run 的 Key。

## 复验命令

```powershell
$env:TEMP='D:\coding\rag\.tmp'
$env:TMP='D:\coding\rag\.tmp'
pnpm db:migrate
pnpm test:backend
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm boundary
pnpm build
pnpm openapi:check
pnpm migration:check
```

内网还要补做多实例取消、Redis 主从切换、代理 SSE 缓冲、并发连接数和 8 小时 soak；这些环境证据不能由外网单实例测试冒充。
