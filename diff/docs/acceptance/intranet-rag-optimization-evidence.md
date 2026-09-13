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
- 上一轮 `diff` 路径镜像校验为 70 个交付文件；本轮按用户新要求保留该目录已有内容，并把本次
  源码、测试、需求/ADR/学习/验收文档和运行配置按原路径增量覆盖进去。

## OPT-015～019：在线回答延迟与上下文收敛

- 固定槽位调度回归证明：首批一个 Run 保持未完成时，另一个完成释放的槽立即只领取 1 条新
  Run；关闭会等待已领取任务，关闭后不再领取。
- Embedding 缓存键测试覆盖文本、模型、revision、维度、查询模板、归一化、输出模式和 Sparse
  格式；同输入跨不同 Run 时间命中缓存，PG 来源复核仍执行两次。
- 混合检索回归构造 3 个查询、2 个空间、Dense/Sparse 共 12 个 Milvus 调用，实测最大在途数
  不超过配置 2；无变化第二轮只执行首轮，记录 `RETRY_QUERY_UNCHANGED`。
- 候选池回归证明检索图可交付 15 条候选而不会按 finalTopK=10 过早裁剪；答案图确认 BGE 收到
  15 条并在精排后保留 10 条。
- 预算回归证明剩余时间不足时不调用 LLM Evidence Rerank；需要修复的 Draft 只生成一次并以
  `REGENERATION_BUDGET_EXHAUSTED` 拒答，未通过草稿不会发布。
- Context 回归证明配置每文档 1 条时，同一制度为三个子问题提供的三条代表证据仍可进入总预算；
  Parent 中重复的直接条款被删除，只保留新增例外，同时上下文含标题路径、revision 和适用期。
- 设置页回归确认界面明确说明数据库 Feature Flag、env 初始化默认值与新/在途 Run 快照关系。

2026-09-13 门禁结果：TypeScript strict、Vue typecheck、ESLint 零 warning、五个后端应用构建、Web
生产构建、四套 Docker Compose 静态配置均通过。Jest 单进程全量第二次复跑时本机出现 Node
原生内存耗尽，因此把相同 80 个 suite 分成五个独立进程复跑，最终 480 tests、19 snapshots
全部通过；Web Console 8 files、14 tests 全部通过。该拆分只释放测试编译内存，没有跳过测试。

`OPT-020` 的 30～50 条内网业务问题、真实模型 P50/P95、质量和容量对比按用户要求未执行；本轮
只报告控制流与契约回归，不声称已经提高内网准确率或实际延迟百分比。
