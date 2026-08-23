# LangGraph 真实问答链路验收记录（2026-08-24）

## 1. 验收结论

本次使用真实 HTTP API、PostgreSQL、Redis/BullMQ、MinIO、Milvus `2.6.4`、Node Parser 和 LangGraph 编排完成了“上传文档 → 解析 → Chunk → Embedding → Milvus 索引 → 对账发布 → 提问 → 检索 → 证据 → 生成 → 引用再鉴权 → 校验 → 最终消息”的闭环。

外网机器没有配置 DeepSeek API Key，因此 LLM、Embedding 和 Reranker 使用仓库内的确定性 fixture Adapter；这能验收协议、超时、快照、权限、数据流和状态机，但不能替代真实模型的语义质量、吞吐或延迟验收。Milvus、PG、Redis、MinIO、Parser 和全部应用服务均为真实进程。

关联需求：`DOC-009`、`IDX-006`、`RET-016`、`ANS-002`、`ANS-003`、`ANS-005`、`ANS-006`、`ANS-009`、`ANS-014`、`ANS-015`。

## 2. 环境与数据事实

| 事实            | 实际值                                                               |
| --------------- | -------------------------------------------------------------------- |
| 用户            | `dev-admin` / `SYSTEM_ADMIN`                                         |
| 空间            | `95c7d2da-471e-4fc0-986d-97b10a1d4b30`                               |
| 文档            | `a12ba580-24e9-4692-b5b4-55a8c8688f87`                               |
| 文档版本        | `af337b12-6d15-4371-b2b2-894ddb93fab1`，内容修订 `2`                 |
| 成功入库任务    | `ingest:af337b12-6d15-4371-b2b2-894ddb93fab1:revision:2:pipeline:v1` |
| ACTIVE Manifest | `3d40c37e-2d80-443a-a20c-755493f10066`，版本 `2`                     |
| Collection      | `rag_chunks_b17f26b11607d5be`                                        |
| 对账            | expected `8` / actual `8`                                            |
| 对账摘要        | `de69cb37aaf5a09e29ef931f9441fd73476eb3571fa07054f68515c4df1d95b5`   |
| 会话            | `03bf636b-51b3-4225-ae88-1b5e6d3ccac9`                               |
| 完整答案 Run    | `bb517acf-4c77-4207-aae5-75c3b9aa5610`                               |
| 最终引用        | `925fd539-d4b1-4239-b1d8-2b2edd7a3b31`                               |

上传源文件为 `test/fixtures/langgraph-demo/travel-expense-policy.md`，大小 `6,109` 字节，SHA-256 为 `dff5fa8ad359700e8382405f489c317b7c57e8a96006178a2d8264c26b5f15bf`。

## 3. 入库验收

任务最终为 `SUCCEEDED / PUBLISH / 100%`：

| 步骤            | 结果        | 处理事实                                        |
| --------------- | ----------- | ----------------------------------------------- |
| `SECURITY_SCAN` | `SUCCEEDED` | 1/1                                             |
| `PARSE`         | `SUCCEEDED` | 1/1                                             |
| `OCR`           | `SUCCEEDED` | Markdown 无需外部 OCR，1/1                      |
| `NORMALIZE`     | `SUCCEEDED` | 1/1                                             |
| `CHUNK`         | `SUCCEEDED` | 23/23 Parser Block；生成 8 个可索引 Child Chunk |
| `QUALITY_GATE`  | `SUCCEEDED` | 自动门禁通过                                    |
| `EMBED`         | `SUCCEEDED` | 8/8                                             |
| `INDEX`         | `SUCCEEDED` | Milvus 8/8                                      |
| `VERIFY`        | `SUCCEEDED` | 跨存储对账 8/8                                  |
| `PUBLISH`       | `SUCCEEDED` | Manifest v2 原子切换为 `ACTIVE`                 |

## 4. 真实问答验收

问题：`预计总费用 6000 元的国内差旅需要哪些人审批，返程后最迟多久提交报销？`

Run 从 `2026-08-23T23:34:41.910Z` 执行到 `2026-08-23T23:34:43.094Z`，最终为 `COMPLETED`。Run 快照锁定 Manifest v2、Embedding/Reranker/LLM revision `1` 和 `answer-validator-v1`，没有在执行中读取热更新后的 Provider 事实。

| Answer Graph 节点             |   耗时 | 关键输出                             |
| ----------------------------- | -----: | ------------------------------------ |
| `answer_retrieve`             | 514 ms | 3 个候选，Sparse 不可用所以 degraded |
| `answer_rerank`               |  11 ms | 3 个候选                             |
| `answer_expand_evidence`      |  94 ms | PG 重新鉴权并扩展父子/相邻材料       |
| `answer_build_evidence`       |  12 ms | 10 条 Evidence Source                |
| `answer_route_evidence`       |   6 ms | `ANSWER`                             |
| `answer_build_context`        |  11 ms | 构造有预算、带注入隔离的上下文       |
| `answer_generate_draft`       |  11 ms | fixture 草稿，attempt 1              |
| `answer_revalidate_citations` |  28 ms | 发布后按当前权限和有效期再次核验     |
| `answer_rule_validation`      |  18 ms | `PASS`                               |
| `answer_final_validation`     |  10 ms | `PASS`                               |
| `answer_finalize`             |  16 ms | `ANSWERED`                           |

检索调试事实：

- Route 为 `KNOWLEDGE`，Plan 为 `DETERMINISTIC`，检索轮次 `1`；
- 从问题中识别出 `AMOUNT` 精确字面量；
- Dense 路线真实查询 Milvus，命中 `8`；
- fixture Embedding 不提供 Sparse，Sparse 路线为 `UNAVAILABLE / SPARSE_NOT_CONFIGURED`，所以 Run 明确标记 degraded；
- 最终保留 3 个候选，没有因权限、Manifest、生效期或删除状态被移除；
- 引用预览通过 Citation API 再鉴权后返回，内容明确支持“6,000 元由直属部门负责人审批、财务负责人复核；返程后十个工作日内报销”。

fixture Answer Model 最终正文是通用模板“已根据企业知识找到相关依据”，没有把上述业务事实改写进正文。该限制被如实记录，内网切换真实 LLM 后必须继续跑黄金集和人工答案质量验收。

## 5. 现场发现并修复的问题

### 5.1 Milvus 停机拖垮 Worker

Milvus SDK `3.0.4` 构造客户端时默认发起未被调用方等待的连接。端口不可用时会形成未处理 rejection 并结束 Worker。修复为创建客户端时传 `__SKIP_CONNECT__: true`，把连接错误收回到被 `await` 的 Port 调用和任务重试边界；回归测试验证该配置。

### 5.2 中文短摘要超过 Milvus 字节上限

首次真实索引在 87% 失败，Milvus 日志显示 `short_summary` 为 895 个 UTF-8 字节，超过 Schema 的 512 字节。修复后首次索引和重建路径共用 500 字符摘要函数，Milvus Schema 使用 2,048 字节，并拒绝复用旧的不兼容 Collection。

首次失败 Manifest `7db0917f-727c-412c-9836-ac07d684acd4` 保留为 PG 审计事实。确认它是 `FAILED` 且 actual vector count 为 `0` 后，删除了它唯一关联的空 Milvus Collection/Alias，再由修订 2 按新 Schema 重建。被删除对象不含已发布向量，不能恢复但不影响任何线上 Head。

### 5.3 同一制度不同章节被误判为冲突

第一条 Run `1bf1793d-c9ad-4ff0-9151-46b06a1ff57f` 的安全路由真实返回 `CONFLICT`。根因是旧规则跨章节比较所有数字，把住宿标准、审批金额和报销天数当成同一事实。现在只在同一子问题、同一末级章节且来自不同文档版本时比较冲突；新增“同一制度不同章节出现不同金额不得误报”测试。第二条 Run 因此正确进入 `ANSWER`。

### 5.4 合法取消事件成为 BullMQ 重试任务

取消首次失败任务后，Outbox 正常发布 `ingestion.cancelled`，但 Worker 将其视为未知处理命令。现在该事件进入 `LIFECYCLE` 分支，只写幂等消费收据，不重新执行入库；未知事件仍然 fail-closed。

## 6. 未替代的上线验收

本记录不勾选 `OPS-011`、`OPS-012`、`OPS-014`、`OPS-020`。24～72 小时 Soak、真实 Chaos、企业确认后的 RPO/RTO 以及内网容量/总指标，必须在真实内网 Provider 和目标硬件上取得报告后完成。
