# 查询规划与混合检索 测试方法

## 自动化分层

- `hybrid-retrieval-core.spec.ts`：六类字面量、路由、历史覆盖、Filter、四子问题、RRF 和多样性。
- `query-rewrite.adapter.spec.ts`：正常、取消、超时、Schema、429、5xx 和模型版本不匹配。
- `milvus-vector-index.adapter.spec.ts`：Sparse 形状、服务端 Manifest Filter 和恶意 Filter 拒绝。
- `hybrid-retrieval.graph.spec.ts`：真实编译图、并行路线、单路降级、两轮上限、调试权限和脱敏。
- `golden-retrieval.spec.ts`：缩写、错别字、代码/日期/版本、多跳、无答案、越权和归档版本。
- `hybrid-retrieval-source.integration.spec.ts`：真实 PostgreSQL 单批回源与状态/时态/权限门禁。

## 关键断言为什么重要

1. 不仅断言“有结果”，还断言错误版本、归档、未来生效和无权结果为空。
2. 单路故障断言 `degraded=true` 且另一路候选仍存在，不能用空数组伪装成功。
3. 两轮测试断言 Dense、Sparse 和 PG 各调用两次，第三次永远不会出现。
4. 调试测试序列化结果后搜索问题和 `displayContent`，防止 DTO 扩字段泄漏。
5. 黄金集同时计算 Recall@40、Hit@5、版本准确率和越权泄漏数。

## 内网必须补跑

Fixture 只证明控制流，不证明真实质量。内网需用批准脱敏集执行真实 Embedding + Milvus：

- 记录 Profile、模型 revision、Collection 和 Manifest；
- 覆盖专业缩写、编号、中文错别字、跨文档多跳和权限负例；
- 比较 Dense-only、Sparse-only、RRF 的 Recall@40/Hit@5；
- 注入 Dense/Sparse 超时，确认单路降级指标和 P95；
- 权限负例泄漏必须为绝对 0，不能用平均分掩盖。
