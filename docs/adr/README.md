# Architecture Decision Records

ADR 记录“当时为什么这样选”，避免半年后只剩代码、没人知道约束。状态分为 `Proposed`、`Accepted`、`Deprecated`、`Superseded`；已经接受的 ADR 不能直接改写结论，只能用新 ADR 取代。

| ADR                                                  | 决策                            | 状态     |
| ---------------------------------------------------- | ------------------------------- | -------- |
| [000](./000-template.md)                             | 模板                            | -        |
| [001](./001-service-boundaries.md)                   | 四进程与分层边界                | Accepted |
| [002](./002-identity-model.md)                       | 单企业 userId + roles 身份模型  | Accepted |
| [003](./003-provider-ports.md)                       | 内外网 Provider 端口            | Accepted |
| [004](./004-sse-run-events.md)                       | SSE 只传递已持久化 Run 事件     | Accepted |
| [005](./005-publish-manifest-and-versioning.md)      | 发布 Manifest 与版本化          | Accepted |
| [006](./006-m01-authorization-and-policy-version.md) | 空间 ACL、语义角色与授权版本    | Accepted |
| [007](./007-document-upload-outbox-and-recovery.md)  | 直传、Outbox 与任务恢复         | Accepted |
| [008](./008-isolated-parser-and-unified-block.md)    | 隔离解析、按页 OCR 与统一 Block | Accepted |
