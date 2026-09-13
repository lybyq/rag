# 内网优化实施证据

## OPT-001：基线与诊断（合成门禁完成，内网性能待补）

2026-09-12 修改前：答案图、答案校验、Evidence、答案模型 Adapter 四组共 38 项通过。

代码基线提交：84ec1265f21ae913e883c81f1d161739922cad25（本轮修改未提交）。数据集 SHA256：a64dfa6b05ce76d42dd3b7a129478161797a734b96d07e0edc20b1136959cdd5。模型、Manifest、Profile 使用测试中的固定合成身份；不访问真实缓存，因此不报告内网冷/热缓存延迟。

首批新增能力：

- 答案阶段 outputSummary 记录 durationMs、generationAttempt。
- 上下文记录实际 included/omitted 数量和估算 Token 数。
- 证据扩展后记录授权材料去重文档数、扩展材料数；不使用原始向量命中统计。
- TIMEOUT、AUTHENTICATION、SCHEMA_ERROR 等采用封闭分类；未知 code/message 不写入审计。
- 生命周期步骤顶层 errorCode 与图阶段 outputSummary 保持同一分类。
- 节点记录 logicalModelCallCount；关闭的额外重排为 0，实际完成或被节点处理失败的调用为 1。底层 HTTP 重试及抛出节点异常前的调用总数仍待更细粒度统计，不能据此宣称完整模型请求数。
- 记录固定材料移除原因和 Validator 错误码；不把未知原因键或被拒文档数量写入面向 Run 的摘要。

新增 40 个合成端口基线：10 个业务文本 × 正常回答、材料缺失、引用撤权、模型超时。包含财务、人事、日期、编号、版本、表格抽取文本及扫描抽取文本。

本批验证结果：四组回归 84 项通过；随后追加真实执行服务到生命周期的错误字段映射测试，答案图专项共 54 项通过。首批六个诊断用例先在原实现失败，再实施修复；40 个数据用例的 Claim ID 已按运行时契约校正。TypeScript strict 和定向 ESLint 通过。

随后增加调用计数与材料移除原因回归，均先失败再修复；答案图专项达到 56 项通过。

这些测试使用真实 LangGraph 与纯函数、模拟检索/OCR/模型 Port，证明控制流及审计，不证明真实 PDF/OCR 解析、同义召回效果、同名文档 SQL 映射或内网性能。后续必须继续补多文档、冲突、版本及真实 Provider/PG/E2E 证据，不能用 40 这个数量替代场景覆盖。

复跑：

```powershell
pnpm test:backend -- libs/rag-graph/src/answer-generation.graph.spec.ts libs/answer libs/evidence libs/model-gateway/src/answer-model.adapter.spec.ts
pnpm exec tsc -p tsconfig.check.json --noEmit
```

当前合成基线、移除原因、逻辑模型调用次数和 40 条版本化输入已完成。底层 HTTP 自动重试次数、内网冷热缓存延迟与业务脱敏失败 Run 仍需在内网补证；这些限制不影响代码门禁，但不能据此宣称真实 P95 已改善。

## OPT-002～006：回答正确性、受控重检索和可关闭 Judge

- Answer Context 保存实际送入模型的 source windows；生成、计算、复核和 Validator 不再使用被 Token 裁剪掉的材料。
- Evidence 单问题也执行问题覆盖检查，记录 title/heading/content 的命中依据；SELF 块优先于父/相邻辅助块。
- 冲突只在有可比较局部范围、同一问题覆盖且存在差异事实时成立；空标题或不同城市中的不同数字不再自动冲突。
- 最终 summary 从已通过校验的 Claim 生成，不接受模型另写一段未经校验的结论。
- `REWRITE_AND_RETRY` 现在真正执行第二轮受限检索，再次重排和构造 Evidence；最多重试一次，继续受总 Deadline 限制。
- Judge 关闭时只接受 DIRECT 可核验 Claim；引用、ACL、Manifest、数字和文本对应检查仍执行。四种 LLM Evidence Rerank/Judge 组合都有调用次数断言。

## OPT-007～010：Dense、GLM、BGE 与纯文本 OCR

- Dense-only 不再因为没有 Sparse `/pooling` 就启动失败；Sparse 权重为 0 时不请求、不写空向量。
- Reranker 明确配置 probability 或 logit；candidateId、数量、rank、乱序、越界和重复均做契约检查，logit 只归一化一次。
- GLM/vLLM 分离 `content` 与 `reasoning_content`，识别非 stop `finish_reason`，三类答案任务有独立输出预算，并可配置是否发送 response format。
- OCR 支持 platform-json、HTTP text、JSON string 和 JSON 顶层文本字段；纯文本仅映射一个真实目标，bbox/confidence 保持未知并产生质量告警。

## OPT-011～013：真实时间线、入库阶段和批量 API

- `run.progress` 从后端步骤事实生成：包含 sequence、阶段、状态、服务端时间、授权空间 ID、去重文档数、Evidence 数和耗时；不存在浏览器自增候选数。
- 前端只显示当前仍可见空间名称；后端 ID 与当前空间集合无法完全对应时使用不含名称的安全文案。
- 上传完成后按真实 jobId 自动打开十步详情；SSE 断开使用游标/ETag 轮询，未知总量使用不确定进度。
- 新增 `POST /api/v1/spaces/{spaceId}/document-batches` 和 `GET /api/v1/document-batches/{batchId}`。batchId 复用 Upload Session，每个文件独立返回上传与 Job 状态。
- 批次 Header 幂等键绑定规范化 Body Hash；`externalSourceId + externalDocumentId` 绑定平台 Document。相同内容 Hash 复用原 Version/Job，变化内容创建新 Version；重复隔离对象尽力删除。
- 外部调用完整示例位于 `rag-intranet-release/EXTERNAL_API_QUICKSTART.md`；clientFileId 仍只用于单批次关联，不冒充长期主键。

## OPT-012：多文件并发审计结论

发现并修复了一个真实发布竞态：多个文档可以从同一个旧 Head 构建候选，后发布者曾可能覆盖先发布成员。新迁移为 indexing run 保存 `base_manifest_id` 与 `rebase_count`；发布事务使用 Compare-And-Swap，Head 已变化时不切换旧候选，而是通过 Outbox 重新排队并基于最新 Head 重建。重建前会清理旧候选的不可见向量，避免垃圾记录累积。

同时新增两层 PostgreSQL 集成用例：同一 Upload Session 两个文件并发 complete 必须得到两个 Document/Job/Outbox；同空间两个索引并发时一个正常发布、一个 REBASE_QUEUED，重跑后的 Head 必须同时包含两份文档。2026-09-13 本机 Docker Desktop 未运行且 `127.0.0.1:5432` 不可达，所以本轮无法现场复跑 PG 集成用例；合成应用层与全部 TypeScript 门禁已通过，内网/启用本地 PG 后仍必须执行 `pnpm test:integration`。

## 2026-09-13 本轮门禁结果

- TypeScript backend strict：通过。
- Vue `vue-tsc`：通过。
- ESLint（零 warning）：通过。
- OpenAPI 生成与一致性：通过。
- 数据库迁移静态门禁：18 个迁移通过。
- 全量后端回归：76 suites、452 tests、19 snapshots 通过。
- Web Console：7 files、13 tests 通过。
- Platform API Nest 装配 smoke：2 tests 通过；Jest 报告已有异步句柄提示，但断言全部通过。
- PostgreSQL 集成：因本机数据库未启动未执行成功，不记录为代码失败，也不勾选总集成门禁。
- 六应用源码构建与 Web 生产构建：通过；本轮按用户要求未重新构建 Docker 镜像。
- `diff` 路径镜像校验：70 个交付文件均与仓库当前源码 SHA-256 一致；测试与需求/学习文档不复制，前端、迁移和运行配置明确包含。
