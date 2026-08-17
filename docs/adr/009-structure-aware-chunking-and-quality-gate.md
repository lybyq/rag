# ADR-009：结构感知 Chunk、可逆去重与质量审核门禁

- 状态：Accepted
- 日期：2026-08-18
- 关联需求：KNO-001～KNO-015

## 背景

M03 已经把不可信文件转换为可定位的 `DocumentBlock`。如果下一步仅按固定字符数切分，会破坏标题、条款、代码、表格和跨页关系；如果重复内容直接删除，又会丢失引用来源。质量问题若只写日志，也无法阻止错误知识进入正式索引。

## 决策

1. M04 引入版本化 `KnowledgeProcessingRun`、`KnowledgeChunk`、`ChunkRelation` 和 `DocumentQualityReport`，所有结果均绑定 `documentVersionId + contentRevision`。
2. 先恢复标题路径、语义边界和阅读顺序，再按 prose、table、slide、sheet、code、FAQ、clause 的专用策略切分；禁止跨越不兼容边界。
3. 每个结构段生成 Parent Chunk，检索粒度生成 Child Chunk；来源 Block、父子、前后邻居、表头、脚注和重复关系单独持久化。
4. `displayContent` 保留适合引用的正文，`embeddingText` 增加标题路径和表头上下文。Token 数由固定 revision 的真实 BPE Tokenizer 计算，不使用字符数估算。
5. 重复 Chunk 仍保存自身和来源关系；策略只决定它是否允许进入后续索引。这样既能降噪，也不破坏审计和引用回溯。
6. 质量 Policy 输出 `PASS`、`MANUAL_REVIEW` 或 `REJECT`。PASS 自动允许进入 M05；MANUAL_REVIEW 必须由具有 REVIEW 权限的用户批准；REJECT 不可通过审核绕过，只能拒绝或要求生成新 content revision 重处理。
7. 审核使用报告 `optimisticVersion` 加行锁，审核事实和任务状态在同一事务提交。要求重处理时创建新 revision、全套步骤和 Outbox，旧 revision 保留。
8. M03 完成后在同一事务写入 M04 Outbox。Worker 按事件类型路由，阶段间不通过进程内直接调用耦合。

## 取舍

- 首版使用 `cl100k_base` BPE 作为可重复的本地 Tokenizer，并把 profile/revision 写入 Run。内网若需要与 Embedding 模型完全一致，可替换 `TextTokenizer` 实现并生成新 content revision，不能修改历史 Token 事实。
- Parent Chunk 也受独立 Token 上限约束，因此超长章节会形成多个 Parent segment；这比保存一个无限大的父块更适合后续上下文扩展。
- 去重不物理删除 Chunk，会增加少量 PostgreSQL 存储，但换来完整来源、可解释审核和策略可回滚。

## 后果

- M05 只能消费 `eligibleForIndex=true` 且 revision 匹配的 Chunk。
- Chunker、Tokenizer 或质量规则 revision 改变时必须重处理生成新 content revision。
- 真实业务 Golden 文档和内网模型 Tokenizer 的最终阈值仍需在 M09 容量与质量评测中校准。
