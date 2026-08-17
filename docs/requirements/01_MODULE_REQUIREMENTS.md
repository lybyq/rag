# M00～M10 模块需求清单

> 本文件是代码落地的主清单。需求编号一经使用不得复用；需求内容发生不兼容变化时通过 ADR 和基线版本记录。

## 总体依赖与交付规则

| 模块 | 名称                  | 前置依赖      | 主要用户价值                     |
| ---- | --------------------- | ------------- | -------------------------------- |
| M00  | 工程与决策基线        | 无            | 可重复开发、测试、部署和观测     |
| M01  | 身份、角色与知识空间  | M00           | 安全访问和知识治理边界           |
| M02  | 文档接入与任务中心    | M01           | 文档可上传、追踪和恢复           |
| M03  | 文件安全、解析与 OCR  | M02           | 异构文件变成统一可定位 Block     |
| M04  | 知识加工、质量与审核  | M03           | Block 变成受控、可审核的 Chunk   |
| M05  | 向量化、索引与发布    | M04           | 知识安全进入或退出在线检索       |
| M06  | 会话、Run 与事件底座  | M01           | 问答请求可追踪、取消和续传       |
| M07  | Query Plan 与混合检索 | M05、M06      | 从正确版本和权限范围找到证据     |
| M08  | 证据、生成与答案校验  | M07           | 生成有依据、可核验、会拒答的答案 |
| M09  | 评测与生产可靠性      | M00～M08      | 质量、性能和故障恢复达到上线要求 |
| M10  | Web 产品与全链路验收  | M02、M06～M09 | 管理和问答用户具备完整使用闭环   |

每个模块都必须同时完成：Schema、领域规则、数据库迁移、API/事件、Adapter、单元测试、契约测试、集成测试、日志/指标/Trace、中文学习文档和验收记录。

---

## M00 工程与决策基线

### 目标

建立可独立构建和部署的 Monorepo、公共契约与本地依赖环境，冻结会影响后续所有模块的工程决策。

### 需求清单

- [x] `BASE-001` 创建 pnpm Workspace 和 NestJS Monorepo，启用 TypeScript strict。
- [x] `BASE-002` 创建 `platform-api`、`rag-query-service`、`ingestion-worker`、`scheduler-worker` 四个后端应用。
- [x] `BASE-003` 创建 Vue 3 `web-console` 应用，采用 `<script setup lang="ts">`。
- [x] `BASE-004` 创建 contracts、domain、application、auth、ingestion、parser、chunking、rag、provider、persistence、observability、config、testing 等库边界。
- [x] `BASE-005` 配置 ESLint Boundary 和依赖图测试，禁止 Domain/Application 反向依赖具体框架或 Adapter。
- [x] `BASE-006` 以 Zod 作为请求、响应、事件和配置的运行时契约真相，并生成 TypeScript 类型和 OpenAPI。
- [x] `BASE-007` 实现统一 API Envelope、错误结构、稳定错误码、Request ID 和 Trace ID 传播。
- [x] `BASE-008` 接入结构化日志、OpenTelemetry Trace、基础指标和敏感字段脱敏。
- [x] `BASE-009` 提供 PostgreSQL、两类 Redis、MinIO、Milvus 的 Docker Compose 外网开发环境。
- [x] `BASE-010` 所有进程启动时使用 Zod 校验配置，缺少关键配置时拒绝启动并给出安全错误信息。
- [x] `BASE-011` 建立 format、lint、typecheck、unit、contract、integration、schema diff、migration 和安全扫描 CI 门禁。
- [x] `BASE-012` 固定包版本到 lockfile，镜像使用不可变 tag/digest，生成 SBOM。
- [x] `BASE-013` 建立 ADR 模板并完成服务边界、身份模型、Provider、SSE、发布 Manifest 和版本化 ADR。
- [x] `BASE-014` 提供开发环境一键启动、停止、健康检查、种子数据和故障排查命令。

### 代码映射

```text
apps/platform-api
apps/rag-query-service
apps/ingestion-worker
apps/scheduler-worker
apps/web-console
libs/contracts
libs/domain
libs/application
libs/config
libs/observability
libs/testing
deploy/docker
docs/adr
```

### 验收门禁

- 五个应用可以独立构建，四个后端进程可以独立启动和健康检查。
- 故意制造跨层依赖、缺失配置、非法 DTO 时，自动化测试能够阻断。
- 一个示例请求能够串起 Request ID、Trace 和结构化日志。
- 新开发者按 README 在空机器上可重复启动本地环境。

### 2026-08-15 实施证据

- `pnpm check` 全量通过：format、lint、strict typecheck、依赖边界、11 个后端测试、1 个 Vue 测试、migration、五应用生产构建、OpenAPI diff、Compose config。
- 四个后端构建产物分别启动在 `3200～3203`，`/api/v1/health/live` 均返回 200 和独立 Request ID。
- Platform API 在依赖全部关闭时仍保持 liveness 200，readiness 返回 503 和五项脱敏失败明细；重复检查不会导致进程崩溃。
- 结构化 HTTP 日志中的 `reqId`、`requestId`、请求头和响应头使用同一关联 ID；`/metrics` 返回 Prometheus Content-Type 和 HTTP 耗时指标。
- Docker Compose 已通过解析，五个基础镜像和两个构建基础镜像全部固定 digest。本机 Docker Registry TLS 被当前网络代理重置，真实基础设施 Integration 将由可联网环境中的 CI job 完成，结果通过前不得宣称生产环境验收完成。

---

## M01 身份、角色与知识空间

### 目标

在没有多租户和组织树的前提下，以 `userId + roles` 建立可适配内网认证、默认拒绝且可审计的资源权限体系。

### 需求清单

- [x] `AUTH-001` 定义可信 `UserContext { userId, roles, authzVersion, resolvedAt }`，只允许 Auth Adapter 创建。
- [x] `AUTH-002` 定义 `AuthPort`，实现 `mock`、`trusted-header`、`jwt` 三种可配置 Adapter。
- [x] `AUTH-003` Mock 模式支持选择预置用户和角色，仅允许在非生产环境启用。
- [x] `AUTH-004` Trusted Header 模式验证请求来自受信代理，并配置 Header 名、角色分隔符和签名/来源校验策略。
- [x] `AUTH-005` JWT 模式验证签名、Issuer、Audience、过期时间、允许算法和 Claim 映射。
- [x] `AUTH-006` 实现内网角色到系统语义角色的配置映射；未知角色默认不赋权。
- [x] `AUTH-007` 建立 `knowledge_spaces`、`knowledge_space_policies`、`resource_acl` 和审计相关数据模型。
- [x] `AUTH-008` ACL 支持 `USER` 与 `ROLE` 两类主体，以及 READ、WRITE、REVIEW、ADMIN 权限。
- [x] `AUTH-009` 创建知识空间的创建、查询、更新、停用、授权和策略版本 API。
- [x] `AUTH-010` 所有 Repository 方法必须显式接收 User/Access Context，禁止隐式全局用户。
- [x] `AUTH-011` 客户端提交的 `requestedSpaceIds` 只能缩小服务端权限，不能扩大。
- [x] `AUTH-012` 缓存 Key 包含用户、角色集合 Hash 与授权版本；授权变化主动失效。
- [x] `AUTH-013` 文档、引用、历史消息、检索候选和导出分别执行当前权限检查。
- [x] `AUTH-014` 认证信息缺失、非法或无法验证时 fail-closed，并返回稳定错误码。
- [x] `AUTH-015` 管理、授权和拒绝访问操作写审计日志，不记录原始 Token。

### 数据对象

```text
knowledge_spaces
knowledge_space_policies
resource_acl
role_mappings（可用配置替代，ADR 决定）
audit_logs
```

### 验收门禁

- Mock、Header、JWT 三套认证契约测试通过。
- 伪造角色、伪造 Header、无权 Space、撤权后缓存、引用重鉴权测试通过。
- 权限泄漏测试结果为 0；认证故障不返回内部知识。

### 2026-08-16 实施证据

需求到源码、自动化测试和浏览器验收的映射见 [M01 实施与验收证据](./M01_IMPLEMENTATION_EVIDENCE.md)。

---

## M02 文档接入与任务中心

### 目标

让用户安全、可恢复地批量上传文档，并让数据库可靠记录文件、业务版本、任务和每个步骤的事实状态。

### 需求清单

- [x] `DOC-001` 定义 Document、DocumentVersion、DocumentFile、IngestionJob、JobStep 和 Outbox 领域契约。
- [x] `DOC-002` 实现文档版本状态机和乐观锁，拒绝非法跳转及并发覆盖。
- [x] `DOC-003` 创建上传会话 API，由服务端生成隔离对象路径和短时预签名 URL。
- [x] `DOC-004` 支持单文件和最多 100 文件的批量上传，数量与大小上限配置化。
- [x] `DOC-005` 大文件使用 MinIO Multipart Upload；支持前端取消、失败分片重试和会话过期。
- [x] `DOC-006` 完成上传时执行 MinIO HEAD，核对对象存在性、大小、类型约束和可用 Hash。
- [x] `DOC-007` 原始文件名只作为净化后的元数据保存，不参与对象路径生成。
- [x] `DOC-008` 上传完成、文件事实、入库任务和 Outbox Event 在同一 PG 事务中提交。
- [x] `DOC-009` Outbox Publisher 使用 `FOR UPDATE SKIP LOCKED` 领取，重复投递时 Consumer 幂等。
- [x] `DOC-010` 稳定 Job ID 包含文档版本、内容修订、步骤和步骤版本。
- [x] `DOC-011` 实现文档/版本/任务详情、分页列表、过滤、重处理、取消和步骤事件 API。
- [x] `DOC-012` 每个步骤记录 queued、running、waiting、succeeded、failed、cancelled、rejected 状态和时间。
- [x] `DOC-013` 步骤进度记录 `processedUnits`、`totalUnits`、`stagePercent`、`overallPercent` 和可公开消息。
- [x] `DOC-014` `overallPercent` 由服务端基于真实步骤权重计算；未知总量时展示不确定进度而非伪造数字。
- [x] `DOC-015` 任务事件支持 SSE `Last-Event-ID` 续传，连接失败时提供带 ETag/游标的轮询 API。
- [x] `DOC-016` 卡住任务能够被 Lease/Heartbeat 检测，并由 scheduler 安全重试或转人工处理。
- [x] `DOC-017` 重处理创建新的 content revision，不覆盖原有解析事实。
- [x] `DOC-018` 上传、取消、重处理和状态迁移写入审计日志。

### 数据对象与 API

```text
documents
document_versions
document_files
ingestion_jobs
ingestion_job_steps
outbox_events

POST /v1/uploads
POST /v1/uploads/{uploadId}/parts
POST /v1/uploads/{uploadId}/complete
DELETE /v1/uploads/{uploadId}
POST /v1/spaces/{spaceId}/documents
GET /v1/documents
GET /v1/documents/{documentId}
GET /v1/document-versions/{versionId}
POST /v1/document-versions/{versionId}/reprocess
GET /v1/jobs/{jobId}
GET /v1/jobs/{jobId}/events
POST /v1/jobs/{jobId}/cancel
```

### 验收门禁

- 200 MiB 文件不经过 API 进程转发字节。
- 重复 Complete、API 事务中断、Outbox 重投和 Worker 重启不丢任务、不重复创建事实。
- 页面刷新后能够恢复上传及后端任务状态。

### 2026-08-16 实施证据

需求到源码、自动化测试、故障注入和浏览器验收的映射见 [M02 实施与验收证据](./M02_IMPLEMENTATION_EVIDENCE.md)。真实 MinIO 镜像因本机 Docker Registry 超时未完成环境联调，已在证据与 Runbook 中明确保留补跑项；代码、契约和其余门禁不以 Fake 结果冒充该项环境证据。

---

## M03 文件安全、解析与 OCR

### 目标

将安全的异构文件转换成统一、可定位、保留原始文本和处理版本的 `DocumentBlock`。

### 需求清单

- [x] `PAR-001` 实现隔离 Bucket、魔数/MIME/扩展名交叉校验和 SHA-256。
- [x] `PAR-002` 集成可配置恶意软件扫描 Port，外网提供本地开源扫描器或测试 Adapter。
- [x] `PAR-003` 检查宏、嵌入对象、外部链接、密码保护、压缩层数、解压比例、页数、像素和表格规模限制。
- [x] `PAR-004` Parser Runtime 使用无外网、只读根文件系统、最小权限和资源/时间上限的隔离容器。
- [x] `PAR-005` 定义 ParserPort 与 OcrPort，输入输出使用 Zod 校验并携带引擎版本。
- [x] `PAR-006` 建立 PDF、DOCX、XLSX、PPTX、图片、HTML、Markdown、TXT、CSV 的格式路由。
- [x] `PAR-007` PDF 按页判断文字覆盖度，可靠文字层不做 OCR，扫描或低覆盖页面进入 OCR。
- [x] `PAR-008` OCR 返回文本、归一化坐标、置信度和引擎版本，低置信页面触发质量告警。
- [x] `PAR-009` 所有 Parser 只输出统一 DocumentBlock，不直接生成最终 Chunk。
- [x] `PAR-010` Block 顺序在同一 parse revision 内唯一稳定，保留 `originalText`，标准化不得覆盖它。
- [x] `PAR-011` 表格保留行列、合并单元格、表头和页/Sheet 信息；PPT 保留 slideNo；PDF/图片保留 bbox。
- [x] `PAR-012` 解析派生对象写入版本化路径并保存 Hash，重复任务可直接校验复用。
- [x] `PAR-013` 解析超时终止整个隔离进程，区分可重试故障、文档问题与开发缺陷。
- [x] `PAR-014` 为每类格式建立代表性 Golden 文档和 Block Snapshot。
- [x] `PAR-015` 支持管理员查看 Parser/OCR Profile、版本、耗时和失败原因。

### 验收门禁

- 文本 PDF 不误触发整本 OCR；扫描 PDF 能按页 OCR。
- Excel 合并表头、PPT 图文、复杂 PDF 和低质量图片能够输出可定位结果或明确进入人工处理。
- 恶意、损坏、超限和密码文件不会静默进入下游。

---

## M04 知识加工、质量与审核

### 目标

从 Block 恢复结构、生成适合检索且可回溯的 Chunk，并通过自动质量门禁和人工审核控制知识质量。

### 需求清单

- [x] `KNO-001` 定义 KnowledgeChunk、ChunkRelation 和 DocumentQualityReport 契约。
- [x] `KNO-002` 恢复标题树、段落、列表、脚注、表格、跨页关系和阅读顺序。
- [x] `KNO-003` 按文档格式和内容类型选择专用 Chunker，不使用单一字符切分覆盖所有格式。
- [x] `KNO-004` 实现 Parent-Child Chunk、前后邻居、表头、脚注和来源 Block 关系。
- [x] `KNO-005` Chunk 不跨不兼容标题、表格、条款和代码边界。
- [x] `KNO-006` 生成 display content 与 embedding text，分别服务引用展示和模型检索。
- [x] `KNO-007` 使用实际 Tokenizer 计算 Token 数，处理超长内容并记录截断/拆分原因。
- [x] `KNO-008` 计算内容 Hash、页内重复、跨页重复和可配置去重，不丢失来源关系。
- [x] `KNO-009` 质量门禁检查解析覆盖、OCR、结构、乱码、重复、缺页、表格、权限负责人和版本冲突。
- [x] `KNO-010` Policy 输出 PASS、MANUAL_REVIEW 或 REJECT，并保存规则版本和原因。
- [x] `KNO-011` 实现质量报告、Block/Chunk 浏览、审核通过、拒绝和要求重处理 API。
- [x] `KNO-012` 审核操作需要对应角色、原因和乐观锁，结果完整审计。
- [x] `KNO-013` 未通过质量门禁或需要人工审核的内容不能进入正式索引。
- [x] `KNO-014` Parser/Chunker 升级生成新的 content revision，旧 revision 保留到安全清理时间。
- [x] `KNO-015` 建立 Chunk Golden Snapshot 和准确字段抽取评测。

### 验收门禁

- 每个 Chunk 能回溯到文档版本、Block、页码/Sheet/Slide 和必要坐标。
- 多级表头、条款、FAQ、代码和重复页测试通过。
- 审核并发、越权审核和审核后重处理不造成状态覆盖。

### 2026-08-18 实施证据

需求到源码、自动化测试、真实 PostgreSQL 并发/重处理验证和环境补跑项见 [M04 实施与验收证据](./M04_IMPLEMENTATION_EVIDENCE.md)。外网使用真实 `cl100k_base` BPE 完成工程门禁；内网 Embedding 官方 tokenizer 与业务 Golden 仍须按验收清单复验，不能将当前 Profile 冒充模型精确计数。

---

## M05 向量化、索引与发布

### 目标

通过可替换的 Embedding 服务生成 Dense/Sparse 向量，经对账后原子发布，并支持模型升级和安全回滚。

### 需求清单

- [ ] `IDX-001` 定义 EmbeddingPort，区分 query 与 document 端点，支持批量、超时和取消。
- [ ] `IDX-002` 定义 EmbeddingProfile：模型、revision、tokenizer、维度、归一化、Sparse 格式和模板版本。
- [ ] `IDX-003` 服务启动读取 `/health` 与 `/metadata`，维度、revision 或协议不匹配时健康检查失败。
- [ ] `IDX-004` 实现 Token 感知的动态批处理、有限并发、部分失败重试和背压。
- [ ] `IDX-005` 相同内容 Hash 与 Profile 的 Embedding 事实幂等复用，同时保持文档来源独立。
- [ ] `IDX-006` 一个不兼容 Embedding Profile 使用独立 Milvus Collection，业务代码只访问 Registry/Alias。
- [ ] `IDX-007` Milvus 保存检索元数据、短摘要、Dense/Sparse 向量，不保存完整正文。
- [ ] `IDX-008` 完成 Manifest ADR，区分 documentVersion、contentRevision、embeddingRevision、spaceManifestVersion 和 profile。
- [ ] `IDX-009` 发布构建中的向量不可被普通检索命中。
- [ ] `IDX-010` 对账至少检查数量、主键缺失、内容 Hash、Profile 元数据和固定关键查询。
- [ ] `IDX-011` 对账通过后在 PG 事务中原子切换空间 Manifest/文档发布成员。
- [ ] `IDX-012` 发布、废止、撤权和回滚事件通过 Outbox 可靠触发缓存失效。
- [ ] `IDX-013` 切换失败保留当前有效版本；新修订可安全重试或清理。
- [ ] `IDX-014` 旧向量异步清理失败仅告警，不影响当前可见性。
- [ ] `IDX-015` 实现 PG、MinIO、Milvus 定时对账和修复/人工处理策略。
- [ ] `IDX-016` 新 Profile 全量重建、离线评测、灰度切换和回退都有自动化流程。

### 验收门禁

- Milvus 中断、批次部分失败、重复 Job 和发布事务失败不影响当前线上版本。
- 单独发布一个文档后，同一空间的其他有效文档仍然可检索。
- Profile 维度不匹配时不允许写入或查询错误 Collection。

---

## M06 会话、Run 与事件底座

### 目标

为问答执行建立可持久化、可幂等创建、可取消、可续传和可审计的运行容器。

### 需求清单

- [ ] `RUN-001` 建立 Conversation、Message、ConversationState、RagRun、RagRunStep 数据模型。
- [ ] `RUN-002` 创建 Run 使用 `Idempotency-Key`，同用户重复请求返回同一 Run。
- [ ] `RUN-003` Run 创建快速返回 `ACCEPTED`、events URL 和过期时间，不同步等待模型。
- [ ] `RUN-004` Run 锁定 flow、policy、prompt、embedding、reranker、LLM、validator、manifest 和 authz 版本快照。
- [ ] `RUN-005` 实现 Run 状态机、乐观锁、Deadline 和终态不可逆规则。
- [ ] `RUN-006` 每个 Graph 节点记录状态、输入/输出摘要、耗时、错误和 Trace，不保存不必要敏感全文。
- [ ] `RUN-007` 每个 Run 使用 Redis Stream 保存顺序事件，事件有 sequence、schemaVersion 和可配置保留期。
- [ ] `RUN-008` SSE 支持会话 Cookie或绑定 `runId + userId` 的短时一次性 Stream Ticket。
- [ ] `RUN-009` 支持 `Last-Event-ID` 补发、心跳、慢客户端处理、完成后重连和 Stream 过期降级。
- [ ] `RUN-010` 取消写入信号并传播 AbortSignal 到检索、Reranker 和 LLM。
- [ ] `RUN-011` 最终结果先持久化，再发布 `answer.completed`；重放不能产生第二份答案事实。
- [ ] `RUN-012` 会话仅保存短窗口、摘要、确认实体和最近引用；每轮重新鉴权历史来源。
- [ ] `RUN-013` 实现 Run 创建、详情、事件、取消、会话列表/消息和反馈 API。
- [ ] `RUN-014` 问题正文支持按合规策略脱敏、加密和保留期清理。

### 验收门禁

- 断线续传无事件丢失或乱序；完成事件之前答案已可从 PG 查询。
- 用户取消能中止下游调用；超时 Run 最终进入 EXPIRED/FAILED。
- 不同用户无法读取对方 Run、事件、会话或引用。

---

## M07 Query Plan 与混合检索

### 目标

在用户权限、空间发布清单和生效时间范围内，将问题转换为受控检索计划并召回高质量候选。

### 需求清单

- [ ] `RET-001` 定义 RetrievalPlan、ExactLiteral、RetrievalCandidate 和 Filter 契约。
- [ ] `RET-002` 先用确定性规则识别 CHAT、KNOWLEDGE、CLARIFY、REJECT 路由。
- [ ] `RET-003` 提取金额、日期、版本、编号、名称和地区等字面量，Rewrite 后不得丢失。
- [ ] `RET-004` 仅在必要时调用 LLM Rewrite/Decompose，并用 Zod 校验后重建安全约束。
- [ ] `RET-005` 当前问题覆盖历史中冲突实体；最多生成 4 个子问题。
- [ ] `RET-006` FilterCompiler 只允许白名单字段/操作符，并强制包含允许空间、Manifest 成员、发布和生效时间。
- [ ] `RET-007` LLM、前端和原始用户文本不能提供 SQL/Milvus Filter 表达式。
- [ ] `RET-008` Query Embedding 使用锁定 Profile，支持缓存但缓存 Key 包含 Profile、计划与权限范围 Hash。
- [ ] `RET-009` Dense 与 Sparse 并行检索，单路失败时按策略安全降级并记录标志。
- [ ] `RET-010` 实现加权 RRF，正确处理重复 ID、单路缺失、并列和配置权重。
- [ ] `RET-011` 实现相同文档/章节去重与结果多样性，防止候选被单一文档占满。
- [ ] `RET-012` 从 PostgreSQL 批量加载候选正文和当前事实，禁止 N+1。
- [ ] `RET-013` PG 回源重新检查文档状态、Manifest、版本、生效时间和权限，失败候选直接剔除。
- [ ] `RET-014` 初始 topK、RRF K、Dense/Sparse 权重按知识空间 Profile 配置并进入 Run 快照。
- [ ] `RET-015` 检索最多两轮，Rewrite 重试不能形成循环。
- [ ] `RET-016` 提供受权限保护的检索调试 API，展示各阶段排名、分数和剔除原因摘要。
- [ ] `RET-017` 建立简称、错别字、精确编号、日期、版本、多跳、无答案和越权 Golden Case。

### 验收门禁

- Recall@40、Hit@5、版本正确率和权限门槛达标。
- 任意客户端字段、LLM 输出和缓存都不能绕过当前权限或发布状态。
- 检索最多执行两轮；向量服务单路失败有可观测降级。

---

## M08 证据、生成与答案校验

### 目标

将检索候选构造成覆盖充分、冲突可见的证据包，生成结构化 Claim，并在输出前执行确定性与语义校验。

### 需求清单

- [ ] `ANS-001` 定义 RerankerPort、EvidenceBundle、AnswerDraft、ValidationReport 和 FinalAnswer 契约。
- [ ] `ANS-002` 使用专用 Reranker 对最多配置数量候选精排，支持超时和受控降级。
- [ ] `ANS-003` 扩展 Parent、Neighbor、Table Header 时重新执行文档和 Chunk 权限/版本校验。
- [ ] `ANS-004` EvidenceBuilder 计算子问题 Coverage、权威级别、生效范围、冲突、缺失条件和置信度。
- [ ] `ANS-005` Evidence Router 支持 ANSWER、LLM_RERANK、REWRITE_AND_RETRY、CLARIFY、CONFLICT、PARTIAL_ANSWER、REJECT。
- [ ] `ANS-006` 低置信证据才允许条件式 LLM Evidence Rerank，不能改变权限和版本事实。
- [ ] `ANS-007` ContextBuilder 进行 Token Budget、来源多样性和明确边界标记，来源中的指令只视为数据。
- [ ] `ANS-008` 金额、日期和可程序化规则优先由确定性代码计算，并保存表达式、结果与来源。
- [ ] `ANS-009` LLM 只生成符合 Zod Schema 的 summary、claims、caveats 和 follow-up，不直接生成最终无结构正文。
- [ ] `ANS-010` 每个 FACT/CALCULATION/QUALIFICATION/WARNING Claim 必须引用 Evidence sourceId。
- [ ] `ANS-011` Validator 检查引用存在性、当前权限、版本、生效时间、金额、日期、编号、覆盖和冲突。
- [ ] `ANS-012` 确定性阻断问题不能被语义 Judge 判为通过。
- [ ] `ANS-013` Semantic Grounding Judge 仅在规则无法判断时调用，并记录版本与使用原因。
- [ ] `ANS-014` 可修复 Draft 最多重生成一次；超过上限转部分回答或拒答。
- [ ] `ANS-015` 严格模式只发送阶段事件，校验通过后才发送正文和引用。
- [ ] `ANS-016` FinalAnswer 支持 ANSWERED、PARTIAL、CLARIFICATION、CONFLICT 和 REJECTED。
- [ ] `ANS-017` 引用 ID 使用服务端生成的不透明标识，预览时重新鉴权并返回最小必要内容。
- [ ] `ANS-018` 用户可对答案提交有用/无用、错误类型和可选说明，反馈关联 Run、证据和版本。
- [ ] `ANS-019` Prompt Injection、伪造引用、无证据结论和敏感正文泄漏进入安全回归集。
- [ ] `ANS-020` 每条 Evidence Route、Validation Outcome 和降级路径都有 Golden Case。

### 验收门禁

- Citation Precision、Unsupported Claim Rate 和拒答指标达到门槛。
- 无权、过期、不存在的引用阻断输出；金额、日期和编号不凭模型猜测。
- 证据不足、冲突和部分覆盖时，用户看到正确而可解释的结果状态。

---

## M09 评测与生产可靠性

### 目标

把系统从“功能可用”提升到质量有基线、容量有证据、故障可恢复、发布可回退的生产状态。

### 需求清单

- [ ] `OPS-001` 建立 evaluation dataset、case、run、metric 和 baseline 数据模型。
- [ ] `OPS-002` 建立解析、Chunk、检索、引用、答案、拒答、冲突、权限和安全评分器。
- [ ] `OPS-003` 评测保存模型、Prompt、Flow、Policy、Manifest、代码版本、均值、方差和失败样本。
- [ ] `OPS-004` PR 对选定 Golden Set 回归；Profile/Prompt/Chunk/检索变更执行完整基线比较。
- [ ] `OPS-005` 提供 API、Worker、PG、Redis、MinIO、Milvus、模型、队列和 SSE Dashboard。
- [ ] `OPS-006` Trace 能定位 auth、planning、embedding、search、PG validation、rerank、evidence、LLM、validation、persistence、SSE 阶段。
- [ ] `OPS-007` 对在线 Run、用户、角色和知识空间实施配置化限流与并发舱壁。
- [ ] `OPS-008` 外部 Client 统一实现 Deadline、超时、重试白名单、指数退避、熔断和取消。
- [ ] `OPS-009` 在线查询与离线任务使用隔离 Redis、连接池、队列优先级和资源配额。
- [ ] `OPS-010` 使用 k6 覆盖基线、日常入库、批量导入、缓存冷热、单依赖故障和 SSE 断连场景。
- [ ] `OPS-011` 执行 24～72 小时 Soak，验证内存、连接、Stream、临时文件和队列无明显泄漏。
- [ ] `OPS-012` 执行 Redis、Milvus、模型服务、Worker、API 单实例和网络延迟 Chaos。
- [ ] `OPS-013` 实现 PostgreSQL、MinIO 和配置的备份恢复；Milvus 可从事实源重建。
- [ ] `OPS-014` 验证企业 RPO/RTO；具体值在内网上线评审前由业务确认，未确认标记 TBD。
- [ ] `OPS-015` 使用 Expand→Migrate→Contract 数据迁移，禁止不可控整表锁和不可回滚发布。
- [ ] `OPS-016` 应用、Flow、Profile、Prompt、Manifest 和 Feature Flag 均可独立灰度与回退。
- [ ] `OPS-017` 完成卡住任务、DLQ、Parser/OCR 故障、索引不一致、Auth 故障、Streams 积压、模型超时、SSE 激增和备份恢复 Runbook。
- [ ] `OPS-018` 完成数据保留、删除、审计导出、安全事件响应和密钥轮换流程。
- [ ] `OPS-019` 生产发布使用不可变镜像、SBOM、依赖扫描、迁移门禁和自动回归报告。
- [ ] `OPS-020` 达到 PRD 中质量、性能、可靠性和权限总指标。

### 验收门禁

- 目标并发和中型规模数据压测达标，资源余量 ≥ 30%。
- 日常离线任务使在线 P95 上升不超过 10%。
- 任意单实例重启不丢事实、不重复发布、不越权；备份恢复和回滚演练通过。

---

## M10 Web 产品与全链路验收

### 目标

提供成熟、克制、信息密度适中的知识运营台和智能问答台，让管理、审核、问答、引用和故障反馈形成完整用户闭环。

### 前端信息架构

```text
工作台
├─ 总览
├─ 知识空间
│  ├─ 空间概览与策略
│  ├─ 文档列表
│  ├─ 上传/处理中心
│  ├─ 文档详情与版本
│  ├─ 解析/Chunk 审核台
│  └─ 检索测试台
├─ 智能问答
│  ├─ 会话列表
│  ├─ 问答主区
│  └─ 引用预览抽屉
├─ 评测中心
├─ 任务与告警
├─ 审计日志
└─ 系统配置
```

### 需求清单

- [ ] `WEB-001` 使用 Vue 3、TypeScript、Vite、Vue Router、Pinia 和 Composition API。
- [ ] `WEB-002` Element Plus 按需导入并使用主题 Token；支持桌面优先和基础响应式布局。
- [ ] `WEB-003` Element Plus X 经项目 Adapter 封装 BubbleList、Conversations、Sender/XSender、Thinking 等能力。
- [ ] `WEB-004` 固定 Element Plus X 版本并建立 Adapter 组件测试，避免上游 breaking change 泄漏到业务页面。
- [x] `WEB-005` 提供开发环境身份/角色切换页；生产环境不展示 Mock 登录入口。
- [ ] `WEB-006` 总览展示空间、文档、处理任务、失败、待审核、已发布、问答和质量趋势。
- [x] `WEB-007` 知识空间列表支持搜索、状态、负责人、文档量和更新时间；操作受权限控制。
- [ ] `WEB-008` 知识空间详情支持基本信息、角色/用户授权、质量策略、检索 Profile 和版本历史。
- [ ] `WEB-009` 文档列表支持批量上传、搜索、格式/状态/版本筛选、排序、分页和批量操作。
- [ ] `WEB-010` 上传中心展示每个文件的网络上传进度、速度、剩余时间、取消、失败分片重试和完成确认。
- [ ] `WEB-011` 入库进度展示真实步骤时间线：扫描→解析→OCR→标准化→Chunk→质量→审核→Embedding→索引→验证→发布。
- [ ] `WEB-012` 每个步骤展示状态、阶段百分比、总体百分比、处理量、耗时、最近消息、Trace ID 和安全错误详情。
- [ ] `WEB-013` 进度页支持刷新恢复、SSE 续传、断线提示和轮询降级，不使用前端定时器伪造进度。
- [ ] `WEB-014` 失败任务提供是否可重试、建议动作、重试/重处理入口和 Runbook 链接；越权用户看不到内部错误。
- [ ] `WEB-015` 文档详情包含概览、版本、质量、原文预览、Block、Chunk、处理历史和审计标签页。
- [ ] `WEB-016` 审核台提供原文与解析/Chunk 对照、页码定位、OCR 置信度、问题列表和审核动作。
- [ ] `WEB-017` 检索测试台展示 Query Plan、Dense/Sparse/RRF/Rerank 结果、来源预览和剔除原因摘要。
- [ ] `WEB-018` 问答台包含会话分组/懒加载、欢迎问题、知识空间选择、模式选择、消息列表和输入区。
- [ ] `WEB-019` 问答运行中展示公开阶段状态和取消按钮；不展示模型私有思维链、系统 Prompt 或隐藏候选。
- [ ] `WEB-020` 答案支持 Markdown、代码、表格、Claim 级引用标记、警告、复制和用户反馈。
- [ ] `WEB-021` 引用点击后打开抽屉，展示文档名、版本、页码、相关原文和预览；每次打开重新鉴权。
- [ ] `WEB-022` 澄清、冲突、部分回答、拒答、超时、取消和降级使用不同但一致的状态视觉。
- [ ] `WEB-023` 评测中心支持数据集、运行、基线对比、指标趋势和失败样本下钻。
- [ ] `WEB-024` 系统配置展示 Provider/Profile 健康、兼容性元数据和非敏感配置；密钥只显示是否已配置。
- [ ] `WEB-025` 任务与告警页支持队列积压、卡住任务、DLQ、对账结果和授权后的运维动作。
- [ ] `WEB-026` 审计页面支持按用户、角色、动作、资源、结果和时间过滤并导出脱敏结果。
- [ ] `WEB-027` 所有页面提供 loading、empty、error、retry、forbidden、cancelled 状态和键盘可达性。
- [ ] `WEB-028` 关键流程通过组件测试和 Playwright E2E：上传发布、审核、检索测试、问答、引用、取消和续传。
- [ ] `WEB-029` 视觉采用“企业知识工作台”方向：内容优先、低噪声、清晰层级，不照搬通用 ChatGPT 页面或模板化渐变卡片。
- [ ] `WEB-030` 前端不得持有长期模型密钥、对象存储密钥或直接访问 Milvus/模型服务。

### 组件边界草案

```text
features/ingestion
├─ UploadBatchPanel.vue
├─ UploadFileRow.vue
├─ IngestionTimeline.vue
├─ StageProgressItem.vue
├─ FailureResolutionPanel.vue
└─ useUploadBatch.ts / useIngestionEvents.ts

features/chat
├─ ConversationSidebar.vue
├─ RagMessageList.vue
├─ RagAnswerMessage.vue
├─ RagRunStage.vue
├─ RagSender.vue
├─ CitationDrawer.vue
└─ useRagRun.ts / useSseReconnect.ts

components/ai-adapter
├─ AiConversationList.vue
├─ AiBubbleList.vue
├─ AiSender.vue
└─ element-plus-x.types.ts
```

### 验收门禁

- 知识维护者可以从创建空间、上传、观察进度、审核一直走到发布。
- 普通用户可以从提问、观察阶段、查看答案、打开引用一直走到反馈。
- SSE 断线、刷新、失败、取消、撤权和移动到后台再返回的交互均有自动化覆盖。
- 不泄漏内部思维链、Prompt、敏感错误、隐藏候选和长期凭证。

---

## 全局非功能需求

- [ ] `NFR-001` 所有 ID 使用 UUIDv7 或 ULID，不以文件名、自增号或对象路径充当业务 ID。
- [ ] `NFR-002` 所有公共契约、事件、错误码、Profile 和 Policy 均版本化。
- [ ] `NFR-003` 所有关键写操作有幂等键、乐观锁、事务、重试或补偿策略。
- [ ] `NFR-004` 所有列表 API 有稳定排序、游标/分页和最大 page size。
- [ ] `NFR-005` 所有批量处理有并发上限、背压和部分失败语义。
- [ ] `NFR-006` 所有远程调用有绝对 Deadline、单次超时、AbortSignal 和可观察错误分类。
- [ ] `NFR-007` 所有缓存都包含影响正确性的版本，并允许安全绕过或失效。
- [ ] `NFR-008` 所有敏感配置来自 Secret Manager/Kubernetes Secret 或本地未提交环境文件。
- [ ] `NFR-009` 数据库迁移可前滚，应用和配置发布可回滚。
- [ ] `NFR-010` 日志、指标和 Trace 采用一致字段字典并执行敏感字段脱敏。
- [ ] `NFR-011` 支持 Windows 外网开发，同时保证容器化 Linux CI/部署行为一致。
- [ ] `NFR-012` OpenAPI、SSE Schema、事件和 Provider 契约变化进入 CI Diff 门禁。
- [ ] `NFR-013` 时间统一使用 UTC 存储和 ISO 8601 传输，前端按用户时区展示。
- [ ] `NFR-014` 错误信息面向用户可行动，内部详细异常仅进入受控日志与 Trace。
- [ ] `NFR-015` 可访问性覆盖键盘导航、焦点、颜色对比、状态文本和屏幕阅读器基础语义。

## 项目完成定义

只有同时满足以下条件，才可以宣布全量生产上线：

- M00～M10 与 NFR 的全部需求已完成或通过正式变更流程移出范围。
- 质量、权限、性能、Soak、Chaos、备份恢复和回滚报告通过。
- 外网 Adapter 已替换或验证为内网 Provider，兼容性矩阵完成签字。
- 安全、合规、数据保留、值班和 Runbook 负责人明确。
- 用户、维护者、审核者、管理员和审计人员的全链路 E2E 验收通过。
