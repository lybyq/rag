# 03｜代码走读：按一次正常运行的执行顺序

## 1. 从公共契约开始

先读 `libs/contracts/src/knowledge-processing.ts`。`KnowledgeChunkSchema` 把展示正文、Embedding 正文、来源位置、tokenizer 修订和索引资格放在一个可验证对象中；`ChunkRelationSchema` 用 refine 保证关系只能指向 Chunk 或 Block 二者之一；`ReviewQualityRequestSchema` 强制原因和正数乐观版本。

只写 TypeScript interface 不够，因为 HTTP JSON、数据库 JSONB 和未来内网服务返回值在运行时都可能漂移。Zod 是真正的入口门禁。

## 2. M03 如何可靠交棒

读 `PostgresDocumentProcessingRepository.complete()`。解析成功不会只把 CHUNK 标成模糊的 WAITING，而是在当前事务中把它变为 `QUEUED`，并写入 `ingestion.knowledge_processing.requested` Outbox。数据库提交成功才可能发布消息；事务回滚则二者都不存在。

`apps/ingestion-worker/src/ingestion-queue.consumer.ts` 根据事件类型路由 M03 或 M04。Inbox key 带阶段，防止相同 eventId 在不同处理器间误判；Consumer 仍通过已有重投机制保证至少一次投递下的幂等。

## 3. 应用服务如何编排

读 `KnowledgeProcessingService.process()`：

1. Repository 只加载当前 revision、M03 已成功且 lease 属于当前 Worker 的 Block。
2. `beginRun` 固定 Chunker、Tokenizer、质量规则 revision，并再次执行数据库 fencing。
3. `buildKnowledgeChunks` 恢复结构并生成 Parent/Child 和关系。
4. `evaluateDocumentQuality` 只接收显式事实，输出三态结论和发现项。
5. `complete` 原子持久化全部结果，并根据结论推进或阻断后续步骤。
6. 任一异常调用 `fail` 写稳定错误分类，不能把未知异常伪装成 PASS。

Application 只依赖 `KnowledgeProcessingRepository` Port 和纯函数，不依赖 Nest、PG 或 Milvus。

## 4. 结构恢复

读 `structure-recovery.ts`。算法按 Block ordinal 保持阅读顺序，用标题 level 维护栈，给后续正文继承 `headingPath`。它识别 FAQ、合同条款、代码、表格、脚注和页眉页脚装饰；跨页不会仅因 pageNo 改变就强制断开同一章节。

每个参与分块的 Block 得到稳定 `boundaryKey`。表格、代码、条款和 FAQ 的 key 不兼容，后续 group 不能跨边界合并。

## 5. 专用 Chunk 构建

读 `chunk-builder.ts`：

- `buildChildCandidates` 先按边界和内容类型分组；
- `buildTableCandidates` 按行组切表，分段时重复多级表头；
- `buildTextCandidates` 合并可兼容段落，原子 Block 超长再走 token 切分；
- `batchForParent` 只聚合同一连续 section，且 Parent 也有上限；
- `createDraft` 计算稳定 ID、SHA、来源位置和 tokenizer revision；
- `linkNeighbors/linkFootnotes/addSourceRelations` 建显式关系；
- `applyDeduplication` 标记重复并保留来源。

特别看 `splitWithinEmbeddingBudget`：BPE 在字符串拼接边界会重新分词，所以“64 减标题 token”只是估计。函数会把每段重新拼成最终 `embeddingText` 计数并逐步收紧，Golden 曾真实捕获一个 65-token 越界，修复后所有 Child 才满足硬上限。

## 6. 质量 Policy

读 `quality-policy.ts`。它计算非空覆盖、OCR 平均置信度、乱码、重复、缺页、畸形表格、标题数量、负责人和版本一致性。发现项有稳定 code、severity 和定位信息。

硬阻断决定 `REJECT`；其他风险决定 `MANUAL_REVIEW`；无风险才 `PASS`。不要把多个布尔 if 散落在 Worker/Controller，否则不同入口可能得到不同资格。

## 7. PostgreSQL 原子提交

读 `postgres-knowledge-processing.repository.ts`：

- `beginRun/complete/fail` 都校验当前 lease owner 与有效期，旧 Worker 不能覆盖新 Worker；
- `complete` 批量写 Chunk 与关系，保存报告和 findings，再推进 Job Step；
- PASS 只给 `UNIQUE/RETAINED_DUPLICATE` 中允许项资格，`SUPPRESSED_DUPLICATE` 永远不进入索引；
- MANUAL_REVIEW 停在质量步骤，REJECT 进入明确终态。

## 8. 审核正常与失败路径

`KnowledgeProcessingAdminService.review()` 先要求 `REVIEW` 权限。Repository 事务用 `SELECT ... FOR UPDATE` 锁报告并检查 `expectedVersion`。`review-policy.ts` 拒绝直接批准硬 REJECT，也拒绝覆盖终态审核。

正常批准：追加 immutable review 与 audit，版本加一，开放 Chunk 索引资格并推进 EMBED。并发失败：第二个审核者得到 409，前端提示刷新。要求重处理：旧 revision 不动，新 revision、新 Job Steps 和 Outbox 一起提交。

## 9. API 和前端

`apps/platform-api/src/m04/knowledge-processing.controller.ts` 只做 Zod 输入解析、可信上下文映射和输出 envelope。API 支持运行历史、详情、Chunk 游标分页和审核。

前端先读 `useKnowledgeProcessing.ts`。副作用和状态不放在 Route View；generation token 防止快速切换任务时旧响应覆盖新详情，Chunk 使用 ordinal 游标。组件职责：

- `KnowledgeQualityPanel`：加载、空、失败、403、重试和组合；
- `QualityReportSummary`：指标与 findings；
- `KnowledgeChunkTable`：来源、token、资格与真实分页；
- `QualityReviewDialog`：动作、原因、提交、取消和 409 提示。

界面展示的状态和进度来自后端事实，没有定时器伪造。
