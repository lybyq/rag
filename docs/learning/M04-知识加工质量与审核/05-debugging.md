# 05｜调试与常见故障

## 1. 先判断故障在哪一层

按以下顺序查，不要一上来改阈值：

1. Job 的 `SCAN/PARSE/OCR/NORMALIZE/CHUNK/QUALITY` 哪一步停住；
2. `knowledge_processing_runs` 是否有当前 revision，状态和 failure code 是什么；
3. `document_quality_reports/findings` 是自动风险还是执行失败；
4. Chunk 的来源、tokenizer revision、dedup 和 `eligible_for_index` 是否一致；
5. Outbox/Inbox 是否已提交、发布和消费；
6. Worker lease 是否已过期或被新 Worker 接管。

## 2. 常用只读 SQL

```sql
SELECT id, job_id, content_revision, status,
       chunker_revision, tokenizer_revision, quality_rule_version,
       failure_code, failure_message
FROM knowledge_processing_runs
WHERE document_version_id = $1
ORDER BY content_revision DESC, created_at DESC;

SELECT verdict, review_decision, optimistic_version, eligible_for_index, metrics
FROM document_quality_reports
WHERE processing_run_id = $1;

SELECT ordinal, granularity, content_type, token_count,
       dedup_status, eligible_for_index, source_locations
FROM knowledge_chunks
WHERE processing_run_id = $1
ORDER BY ordinal;
```

参数必须绑定，不能把用户输入拼进 SQL。

## 3. CHUNK 一直 QUEUED

检查 M03 事务是否有 `ingestion.knowledge_processing.requested` Outbox，Publisher 是否发布，Consumer Inbox 是否已有同阶段记录，以及 ingestion-worker 是否启用了当前配置。不要手工把步骤改成 SUCCEEDED，这会制造没有 Chunk 事实的假完成。

## 4. `LEASE_LOST` 或旧 Worker 提交失败

这通常是正确保护，不一定是 bug。检查任务是否长时间无 heartbeat、Worker 是否暂停、系统时间是否异常、数据库连接是否卡顿。新 Worker 接管后，旧 Worker 即使晚到也必须被 fencing 拒绝。

## 5. Child 超过 token 上限

核对报告中的 `tokenizerProfileId/revision` 与实际 Worker 配置。不要用字符长度复核；直接用同 revision Tokenizer 对完整 `embeddingText` 计数。若只对正文计数，标题前缀会漏算。当前算法会对拼接后的最终文本重新校验；若标题路径本身占满预算，会明确失败而不是生成违规 Chunk。

## 6. 表格分段后失去语义

检查 M03 Block 的 `table.headerRowCount/rows/mergedCells` 是否正确。M04 只能恢复已有结构，无法可靠猜回 Parser 已丢失的多级表头。若输入正确，再检查每个 TABLE Child 是否重复 header、是否有 `TABLE_HEADER` 和 `SOURCE_BLOCK` 关系。

## 7. 文档意外进入人工审核

从 findings code 查具体原因：覆盖率、OCR、乱码、重复、缺页、畸形表格、标题、负责人或版本冲突。阈值是版本化 Policy；调整后必须新建 rule version 和 content revision，不能直接改旧报告结论。

## 8. 审核返回 403 或 409

- 403：当前 `userId + roles` 没有文档所属 Space 的 `REVIEW`，Repository 的二次 ACL 也会拒绝；
- 409：页面看到的 `optimisticVersion` 已过期，重新加载报告后再判断，不能自动重放审核动作。

审核原因属于审计事实，不应在普通日志、指标标签或错误堆栈中打印全文。

## 9. 审核通过但不能进入索引

先确认自动 verdict 不是硬 `REJECT`，review decision 是 `APPROVED`，报告资格为 true。再查 Child：Parent 不用于向量精确检索，`SUPPRESSED_DUPLICATE` 仍必须 false。M05 尚未实现时，正确状态是 EMBED 等待，不是已经发布。

## 10. 当前机器的基础设施限制

本轮 PostgreSQL M04 集成全部通过；全套 `infra-health` 因本机 MinIO 与 Milvus 未启动而失败。M04 本身不调用 Milvus，MinIO/Milvus 的真实联调不能用 Fixture 结果替代。启动前先把 Docker data-root 放到 D 盘，避免继续占满 C 盘。
