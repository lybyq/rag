# LLM Wiki 实施计划：第三方编译内核与企业集成

> 2026-09-24 顺序更新：先实施受控 Agentic RAG Auto，再评估本 Wiki 计划。下文“第一/第二大阶段”为原先顺序，当前执行顺序以需求 README、ADR-017 和 agentic-rag-auto-implementation-plan.md 为准；Wiki 不再是 Agentic 的前置依赖。

- 修订：2026-09-13，第二版，替代同文件第一版的自研编译方案。
- 决策：用户已确认第三方编译器优先；本文为实施计划，所有功能尚未验收。
- 第一大阶段：LLM Wiki，包括内网 Wiki 平台作为来源和发布目标。
- 第二大阶段：受控 Agentic RAG，第一阶段只预留只读接口。
- 默认编译内核：atomicstrata/llm-wiki-compiler；先通过集成验证，再锁定生产版本。
- 现有约束：单企业内网，userId + roles，NestJS/TypeScript/Vue，PG、两套 Redis、Milvus、GLM-4.7/vLLM、Embedding、Reranker、纯文本 PaddleOCR。
- 原 WIKI-001～039 编号保留并按新职责修订，新增 WIKI-040～047 编译器集成需求；全部保持未完成。

## 1. 本阶段交付什么

用户发布企业文档或导入内网 Wiki 页面后，系统自动生成有主题、有页面关系、可回看原文的 Wiki。
用户可以浏览目录、搜索主题、查看引用和版本；管理员可以重建、审核、发布、取消、恢复和回滚。
生成结果还能同步到现有内网 Wiki 平台的专用目录。

核心算法采用第三方编译器：概念抽取、跨文档概念合并、页面生成、链接修复、增量编译和基础 Lint/Eval。
项目实现 Adapter 和企业业务：把已有文档事实交给编译器，再把编译产物校验、保存、索引和发布。

验收之前不会把“能够调用 SDK”标为“企业 Wiki 已完成”。第三方集成遇到缺口时，优先使用公开扩展点或小范围补丁；
记录具体证据后再决定替代方案，不能静默恢复成整套自研编译算法。

## 2. 已核实信息与待验证事项

以下依据本轮已读取的官方仓库、SDK文档和 npm 元数据，作为候选基线；实施时必须锁定发布包，不能以不断变化的 main 作为生产依赖。

| 项目         | 已核实内容                                                    | 对本项目的意义                                       |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| 编译器身份   | atomicmemory 仓库跳转至 atomicstrata/llm-wiki-compiler        | 避免混用同名插件项目                                 |
| npm 包       | llm-wiki-compiler，查询到版本 1.3.0，MIT                      | 可作为候选依赖，最终记录 integrity、commit 和许可证  |
| 运行时       | 包声明 Node >=24，ESM 导出                                    | 独立 Node 24 编译执行器，验证与当前服务构建兼容性    |
| SDK          | createWiki、ingestText、compile、lint、runEval、exportJson 等 | 可直接调用编译能力，减少重复实现                     |
| 存储         | 项目目录中的 sources、wiki、编译状态等                        | 用作隔离工作区和中间产物，正式业务事实保存在 PG      |
| 模型         | OpenAI-compatible Provider，可配置模型和地址                  | GLM-4.7 的实际结构化提取协议需要单独测试             |
| 进度         | SDK文档说明 v1 无编译进度回调                                 | 第一轮真实阶段事件；页面级事件需验证并补扩展点       |
| 编译选项     | 文档包含 review、embeddings 等选项                            | 关闭内置 Embedding，避免重复向量化；核实候选导出方式 |
| 提示词政策   | systemPolicy 是建议性约束                                     | 来源和权限仍由本地业务校验                           |
| 其他同名项目 | ussumant/llm-wiki-compiler 是编辑器插件路线                   | 不作为服务端依赖                                     |

官方证据：
[仓库](https://github.com/atomicstrata/llm-wiki-compiler)、
[SDK](https://github.com/atomicstrata/llm-wiki-compiler/blob/main/docs/guides/sdk.mdx)、
[包声明](https://github.com/atomicstrata/llm-wiki-compiler/blob/main/package.json)、
[Provider](https://github.com/atomicstrata/llm-wiki-compiler/blob/main/docs/configuration/providers.mdx)。

尚未证明的内容必须进入首批验证：发布包与 main 的 API 一致性、review 候选如何读取、增量删除是否重建所有受影响概念、
GLM tool_calls 支持、模型请求总预算、页面级事件、取消后资源回收、离线依赖完整性。已有测试文件并不代表已在本环境运行通过。

## 3. 分工与边界

| 能力                        | 第三方编译器               | 本项目                                            |
| --------------------------- | -------------------------- | ------------------------------------------------- |
| Parser/OCR、Chunk、原始发布 | 不使用其 URL/文件采集能力  | 复用已有入库链                                    |
| Concept 抽取和合并          | 直接复用                   | 配置语言、预算、页面类型，验收质量                |
| Wiki 页面与关联生成         | 直接复用                   | 将输出转换为受控页面契约                          |
| 增量影响分析                | 复用其文件 Hash 和依赖处理 | 提供 Manifest 差异，验证删除与继承结果            |
| Lint/Eval                   | 复用断链、孤儿、引用等检查 | 增加真实来源复核和企业语料评测                    |
| 原始来源身份                | 文件与行号引用             | 映射至 Manifest、文档版本、Chunk、contentRevision |
| 工作区                      | 文件型中间状态             | 隔离、快照、Hash校验、恢复与保留                  |
| 运行管理                    | 执行一次编译               | BullMQ、PG租约、取消、超时、进度和审计            |
| 权限与发布                  | 不负责企业放行             | 当前权限、版本、校验、原子Head                    |
| 在线检索与问答              | 不调用其 query/save 链     | PG + 独立Milvus索引，未来复用原始证据回答         |
| 内网 Wiki 同步              | 不负责                     | Source/Publisher 两个连接器                       |

第一阶段不建设图数据库、自由Agent、多人协同编辑器、代码仓库分析或跨空间自动汇总。
原文是事实源，生成Wiki是派生内容；禁止自动回灌成原始文档。

## 4. 总体执行链

```text
上传文档 / 内网Wiki人工页面
→ 现有解析、OCR、Chunk、审核、向量化
→ 原始Manifest发布
→ Outbox → rag-wiki-build队列 → ingestion-worker领取
→ 冻结Manifest和编译Profile
→ 导出标准来源文件与source-map
→ 准备独立工作区和可继承的编译缓存
→ Node 24执行器调用llm-wiki-compiler
→ 收集编译产物、Lint、编译报告
→ Adapter解析页面和引用
→ 企业来源与语义质量校验
→ Wiki摘要Embedding → 独立Milvus Collection → 对账
→ PG原子切换Wiki Head
→ 本地浏览 / 异步同步内网Wiki
```

LangGraph负责外层节点：
load_snapshot → prepare_workspace → compile_with_provider → collect_artifacts →
normalize_and_validate → index → reconcile → publish_or_stale。

Concept抽取、正文生成和内部链接修复由编译器执行，不再并行维护一套自研 plan_catalog / generate_pages 算法。

## 5. 编译器 Port 与执行器

### 5.1 自有契约

以下是本项目拟新增的契约，不是第三方已经提供的API：

- WikiCompilerPort.compile(input, executionContext)：执行编译，返回产物清单和执行报告。
- input：buildId、attemptId、sourceBundleRef、sourceBundleHash、baseArtifactRef、compilerProfileSnapshot。
- executionContext：deadlineAt、AbortSignal、leaseToken、受控事件回调。
- result：artifactManifest、compilerVersion、patchRevision、sourceHashes、页面数量、Lint报告、warnings、用量与退出状态。
- 事件：STARTED、HEARTBEAT、PHASE_COMPLETED、ARTIFACT_READY、FAILED；页面事件只有真实扩展点存在时才发送。

Domain只依赖此Port。SDK只由独立编译包引用，避免ESM、Node24和额外依赖进入所有应用的公共依赖入口。

### 5.2 运行时与部署

首选方案是在 ingestion-worker 镜像中附带独立 Node24 执行器及锁定的编译包，通过子进程调用。
现有五个后端和一个前端的应用边界保留；能否维持六镜像须由离线构建和镜像体积验证确认，不预先承诺零部署变化。

- 本地开发使用配置指定的 Node24 绝对路径；编译工作区默认 D:/rag-runtime/wiki。
- Linux使用专用工作目录、非root用户和权限隔离；不挂载用户主目录或整套生产密钥。
- 子进程参数由结构化数据传递，不拼接shell命令；不把密钥写入命令行。
- 仅注入选定编译模型所需环境、任务路径和TLS信任配置。
- 显式固定OpenAI-compatible Provider，禁止自动回退读取编辑器登录或公有模型配置。
- 取消时终止子进程及其子进程树，超时强制终止；远端模型是否停止推理由服务端能力决定，晚到结果绝不发布。
- 若双运行时打包不合适，再在首批报告中比较“只升级Worker至Node24”和“独立编译容器”；更改部署方案需写ADR。

### 5.3 GLM模型访问

优先把编译器模型请求接到本项目受限 OpenAI-compatible 桥接入口，由现有Model Gateway控制真实GLM地址、
凭据、请求预算、Trace和取消。桥接需完整验证编译器实际使用的chat/tools/stream字段，不假设已有入口直接兼容。

如果公开SDK支持注入Provider，则优先直接映射现有Port。验证后在ADR中固定唯一生产路径。
编译器内部Embedding关闭，Wiki向量化由现有EmbeddingPort完成；不要求Sparse接口。

提取依赖tool_calls时，必须验证vLLM实际响应。若只能可靠返回结构化JSON，做小范围Provider补丁并执行Schema验证。
普通聊天成功不能替代此项验收。

### 5.4 补丁维护

优先锁定上游发布版本。确有缺口时使用可重放包补丁或固定commit的受控fork，保留MIT许可与NOTICE。
补丁范围限于进度钩子、取消/Provider接入、受控产物导出和明确的缺陷修复；不要复制整套算法形成第二实现。
每个补丁记录原因、改动点、上游基线、测试和升级冲突。首批提供补丁必要性与维护成本结论。

## 6. 来源导出与引用映射

### 6.1 输入来源包

从指定Manifest的PG事实导出标准化Markdown，保持标题层级、表格、适用条件和原始顺序。
使用稳定、无业务秘密的文件标识，文件名不含revision；改版通过内容Hash变化触发增量。

- 原始文档稳定ID映射至来源文件，过长文档按稳定章节边界拆分。
- source-map保存文件ID、实际输出行范围、Manifest、documentId、documentVersionId、contentRevision、Chunk及来源位置。
- 所有文件、source-map与集合清单计算Hash；编译Profile变化单独记录。
- 清单Hash可变化，但不把每次构建的时间或Manifest ID写进每个来源正文，避免所有未变文件被误判为变化。
- 行号基于真实导出字节及规范化换行计算，不用模型推断；一个文本区间可关联多个重叠Chunk。
- 使用ingestText或受控文件导入，验证其重命名、截断行为；返回truncated必须阻止静默发布。

### 6.2 产物引用转换

Adapter保留原始编译Markdown及其Hash，再解析为本地页面结构：
title、summary、pageKind、sections、paragraphs、citations、links、validationStatus。

- 文件/行引用只能解析到本次source-map中的真实条目。
- 无行号引用只证明来源归属，不冒充精确句子证据；标记DOCUMENT级，进入进一步校验或审核。
- 行范围超界、路径越界、未知来源、跨空间来源直接阻止发布。
- 标题、摘要、目录介绍和页面正文都可能包含事实，均纳入来源校验。
- 编译器未输出逐Claim结构时，Adapter先做段落级映射；不能凭空给每句话附上整篇文档作为“验证通过”。
- Markdown解析、HTML净化与链接白名单使用确定性代码；外部图片和脚本不自动执行。

### 6.3 事实校验的限度

引用存在、日期金额匹配，只能证明结构和部分字面量正确，不能证明句意被原文支持。
发布门禁分为来源身份校验、关键字面量校验、语义支持评估和人工审核。
语义检查可复用编译器Eval及现有Judge，但不能覆盖确定性阻断项。低置信或条件遗漏进入REVIEW_REQUIRED。
首次按空间人工发布；自动发布只能在该空间的真实质量基线通过并启用策略后开放。

## 7. 编译工作区、增量和恢复

工作区按 spaceId/buildId/attemptId 隔离。不能让两个SDK实例写同一个root。
文件锁只能作为库内保护，分布式所有权由PG租约和fencing token控制。

1. 从最近一次成功发布且配置兼容的编译快照恢复工作区。
2. 根据Manifest差异添加、修改、移除来源文件。
3. 让编译器执行自己的概念合并和增量依赖算法。
4. 对全部产物再次检查来源，确保删除内容不残留在正文、摘要、目录和关联关系中。
5. 对账后保存不可变编译快照及其Hash，正式发布版本关联该快照。
6. 崩溃时从可信快照重新执行；只有库明确支持且验证过的checkpoint才能续跑。

缓存兼容键包含编译器版本、patch revision、模型Profile、prompt/schema配置、语言、导出器和产物转换器版本。
失配执行全量编译；不沿用未知格式的内部状态。
复制复用页面时更新本版本来源绑定，不跨版本引用可变内部对象。

多文件连续发布时，PG合并最新目标，未运行旧任务标为SUPERSEDED；运行中任务发现来源过时不得发布。
文档删除和权限收缩优先使受影响Wiki不可服务，不能为了“旧版仍在线”继续暴露已撤销内容。

## 8. 生命周期、数据和发布

### 8.1 状态

- Build：QUEUED → PREPARING → COMPILING → IMPORTING → VALIDATING → INDEXING → RECONCILING → READY → SUCCEEDED。
- 分支：REVIEW_REQUIRED、FAILED、CANCELLING → CANCELLED、SUPERSEDED。
- Wiki版本：BUILDING → VERIFIED → ACTIVE → SUPERSEDED；FAILED和STALE不可作为当前知识读取。
- 审核状态与版本状态分开记录，人工批准不能绕过来源失效。

### 8.2 数据表与产物

| 数据对象                                                                           | 作用                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| wiki_build_profiles                                                                | 编译器、模型、补丁、预算与策略revision             |
| wiki_build_runs / wiki_build_steps                                                 | 租约、重试、取消和真实进度                         |
| wiki_artifacts                                                                     | 对象存储中的来源包、编译快照、原始产物、报告及Hash |
| wiki_versions / wiki_heads                                                         | 不可变版本与当前发布指针                           |
| wiki_pages                                                                         | 规范化正文、页面类型、标题、摘要、稳定身份         |
| wiki_page_sources / wiki_page_links                                                | 原文溯源和页面关系                                 |
| wiki_validation_reports / wiki_reviews                                             | 结构、语义、冲突和人工审核记录                     |
| wiki_page_embedding_refs / wiki_reconciliation_reports                             | 独立向量索引与数量/身份对账                        |
| wiki_build_event_outbox                                                            | 顺序事件与断线续传事实                             |
| wiki_platform_connections / wiki_platform_space_mappings                           | 远端配置引用和权限映射                             |
| wiki_external_page_bindings / wiki_platform_sync_runs / wiki_platform_sync_cursors | 发布映射、同步结果与游标                           |

sections/paragraphs可先存受Zod约束的JSONB；只有需要逐Claim查询时再拆子表。
不预设第三方天然输出旧计划中所有Claim类型。

### 8.3 原子发布和回滚

本地PG事务校验当前Manifest、当前政策版本、预期Wiki Head和租约token，成功后切Head并写Outbox。
Milvus提前写入不可见版本，PG作为可见性入口。模型、文件或Milvus成功均不能单独宣布发布成功。

原始Manifest变化后，旧Wiki默认标为STALE，普通读取不继续将其当作当前制度；管理员可在当前权限下查看带标记的历史版本。
同一Manifest下的重新编译失败，旧版仍可在线。
回滚只能选择来源仍有效的历史Wiki；跨Manifest历史不能通过只切Wiki Head重新成为当前知识。
需要恢复旧内容时应走原文版本治理，再为当前Manifest编译Wiki。

## 9. 权限、搜索和未来Agent接口

- 一个构建只处理一个知识空间的同等授权内容；页面级ACL无法映射时隔离，不能先混合摘要再过滤来源。
- userId + roles沿用现有授权系统；构建服务能读取不代表普通用户能读取。
- 目录、摘要、搜索、页面、数量、关系和引用预览全部重新鉴权。
- 权限变更和文档失效影响已生成摘要，须使页面不可读或重新构建；只隐藏引用链接不够。
- 缓存必须在当前权限检查后使用，并隔离授权主体/策略决策；禁止只用policyVersion作为跨用户授权依据。
- Wiki标题和摘要进入独立Milvus Collection，向量命中后PG检查版本和权限再返回。
- 编译器query、query --save和它自己的检索内核不进入在线主链。

未来第二阶段使用：
WikiQueryPort.searchPages、WikiQueryPort.loadPageEvidence。
后者返回当前可用原始证据及来源映射，Agent最终复用现有答案生成校验链。

## 10. 现有内网 Wiki 平台集成

### 10.1 来源方向

人工Wiki页面和附件 → Source Adapter → 现有外部批量导入 → Parser/OCR/审核/Manifest → 编译器。

- 外部身份复用externalSourceId + externalDocumentId；使用远端稳定pageId，不依赖标题和URL。
- remote revision、内容Hash、父子关系和源链接保留；只改远端revision但内容不变可更新同步元数据，避免重复入库。
- 增量变更和删除使用游标/事件；403或暂时未列出不等于删除。只有明确删除标记或完整扫描对账才能形成tombstone。
- 游标在变更全部可靠持久化为可恢复任务后推进，页面失败通过任务重试；不能丢弃未落库项。
- 页级ACL必须映射到本地等价或更严格的受众，失败则隔离。远端权限收缩立即阻断相关本地内容服务。

### 10.2 发布方向

本地Wiki发布 → Outbox → Publisher Adapter → 远端AI专用目录。

- 绑定stableKey与remotePageId，以目标版本+页面键实现幂等；超时后先查询绑定和远端结果，避免重复创建。
- 远端发布逐页对账；部分失败不回滚本地Head。
- 目标目录/页面受众必须不宽于来源允许受众。无法证明权限等价时停止发布；仅放来源链接不能防止正文泄漏。
- 使用远端revision/ETag条件更新，人工修改进入REMOTE_EDIT_CONFLICT。
- 远端不支持原子条件写时，单次Hash检查不能消除竞态；只允许受控独占写目录，或转人工发布。
- 版本目录全部上传后再切远端入口；平台不支持时显示“同步中”与版本标识，不能承诺跨平台原子性。
- 本地撤权/下线触发远端撤销任务并告警。需要同步立即撤权保证而平台不支持时，禁用正文镜像，只提供受本地鉴权保护的入口。
- AI专用目录、remotePageId绑定、managedBy元数据三层防回灌；禁用自动双向覆盖。

### 10.3 尚缺的平台信息

平台产品和版本、API/认证、页面与附件示例、ACL、版本条件更新、分页游标、Webhook和删除能力。
通用Port、测试服务可先完成；真实Adapter在这些材料齐备后完成验收。
普通网页抓取只能作为明确授权的只读降级方式，不能凭登录页面推断拥有发布API。

## 11. API与前端

读取接口：空间Wiki摘要/目录、页面、搜索、来源预览。
管理接口：创建构建、查询进度、取消、重试、审核决定、发布、历史版本和回滚。
同步接口：连接探测、空间映射、拉取、发布、同步状态、重试和冲突处理。
全部遵守现有 /api/v1 路由、身份、Zod和OpenAPI规范；变更接口有幂等键和预期版本。

前端放在知识空间工作台：

- 普通视图：目录、主题页、相关页、搜索、原文预览、版本/来源时间。
- 管理视图：编译器版本、真实阶段、报告、审核、失败重试、取消、远端同步与冲突。
- 每个视图包括加载、空、失败、无权限、取消、过期及重试状态。

进度分两个交付层级：

1. 直接SDK接入时，显示“来源准备完成、编译器运行中、运行时长、产物校验、索引、发布”等真实事件。
2. 页面级数量必须由已验证补丁或上游钩子产生，编译器内部回调缺失时显示未知，不用扫描半写文件或计时器伪造百分比。

原计划的页面级可视化要求保留为最终验收项；首批明确扩展方式和维护成本。
心跳只表示执行器存活，不表示又完成一页。不展示原始思维链。
SSE使用PG持久化序号与Redis投影，支持重连、去重和权限复核。

## 12. 配置草案

以下为计划字段，尚未加入真实env。应用配置经Adapter转换为锁定版本支持的编译器配置，不能把计划字段当作上游原生变量。

```env
# 初始关闭，数据库空间开关控制试点；env是启动默认值。
WIKI_ENABLED=false
WIKI_READ_ENABLED=false
WIKI_AUTO_BUILD_ON_PUBLISH=false

# 唯一默认内核；版本在lockfile固定，不允许生产运行时下载latest。
WIKI_COMPILER_ENGINE=LLM_WIKI_COMPILER
# 留空则由镜像内固定路径解析；本地必须填写已安装Node24的绝对路径。
WIKI_COMPILER_NODE_PATH=
# Windows默认D盘；Docker覆盖为挂载的工作目录。
WIKI_COMPILER_WORK_ROOT=D:/rag-runtime/wiki
# 限制整个编译任务并发，避免各任务内部并发叠加压垮GLM。
WIKI_COMPILER_MAX_CONCURRENT_BUILDS=1
# 页面并发仅在锁定版本适配验证后生效；无法支持时拒绝配置或明确降级。
WIKI_COMPILER_PAGE_CONCURRENCY=3
WIKI_COMPILER_BUILD_TIMEOUT_MS=1800000
WIKI_COMPILER_REQUEST_TIMEOUT_MS=60000
WIKI_COMPILER_TERMINATION_GRACE_MS=5000
WIKI_COMPILER_MAX_ATTEMPTS=3
# CPU、磁盘和输出大小由执行器与部署共同限制；不能只靠提示词限制。
WIKI_COMPILER_WORKSPACE_MAX_BYTES=2147483648
WIKI_COMPILER_MAX_OUTPUT_BYTES=104857600

# 引用受控GLM配置，实际密钥由模型桥接层管理。
WIKI_COMPILER_MODEL_PROFILE_ID=
WIKI_LANGUAGE=zh-CN
# 开始阶段需要人工审核；自动发布后续按空间灰度。
WIKI_PUBLISH_POLICY=MANUAL_REVIEW
# 第三方编译器不生成向量，由本系统统一处理。
WIKI_COMPILER_EMBEDDINGS_ENABLED=false
MILVUS_WIKI_COLLECTION=rag_wiki_pages

# Wiki平台的两个方向独立启用。
WIKI_PLATFORM_ENABLED=false
WIKI_PLATFORM_SOURCE_SYNC_ENABLED=false
WIKI_PLATFORM_PUBLISH_ENABLED=false
# 产品/协议尚未确认；空值表示未配置，不代表已有通用万能Adapter。
WIKI_PLATFORM_PROVIDER=
WIKI_PLATFORM_BASE_URL=
WIKI_PLATFORM_API_TOKEN=
WIKI_PLATFORM_GENERATED_NAMESPACE=RAG-AI-WIKI
WIKI_PLATFORM_REQUEST_TIMEOUT_MS=10000
WIKI_PLATFORM_SYNC_INTERVAL_SECONDS=300
```

编译器包版本、Node运行时版本、patch revision、模型Profile、有效配置和能力快照写入Build及WikiVersion。
容量默认值是试点起点，不是对中型规模吞吐的承诺；还需限定Token、页面数和模型总调用数。

## 13. 需求清单

### 原有编号修订

- [ ] WIKI-001：定义Build、Profile、Artifact、Page、来源和校验契约，保存编译器版本信息。
- [ ] WIKI-002：跨层Zod与OpenAPI契约，未知/坏产物拒绝导入。
- [ ] WIKI-003：纯领域规则依赖Port，第三方SDK隔离在编译执行器包。
- [ ] WIKI-004：保留编译Markdown，确定性转换为本地结构与引用层级。
- [ ] WIKI-005：PG迁移、约束、索引、Artifact与版本关联。
- [ ] WIKI-006：Build租约、续租、fencing、幂等、有限重试、取消和恢复。
- [ ] WIKI-007：审核、原子Head、历史与来源有效的回滚。
- [ ] WIKI-008：Manifest并发发布、最新目标合并、过时产物禁止发布。
- [ ] WIKI-009：复用第三方概念抽取/合并及目录产物，校验本地目录。
- [ ] WIKI-010：复用第三方页面生成，建立真实来源映射。
- [ ] WIKI-011：来源身份、版本、revision、适用期和字面量校验。
- [ ] WIKI-012：语义支持、条件例外与冲突检查，低置信人工审核。
- [ ] WIKI-013：复用链接解析与Lint，建立版本内页面关系。
- [ ] WIKI-014：Manifest差异映射为来源文件增删改。
- [ ] WIKI-015：复用第三方增量编译，快照继承、删除闭包及全量失效规则。
- [ ] WIKI-016：现有EmbeddingPort与Wiki独立Milvus索引，PG回源。
- [ ] WIKI-017：编译器和Wiki故障隔离，普通RAG回归通过。
- [ ] WIKI-018：所有Wiki内容与元数据执行当前授权。
- [ ] WIKI-019：缓存隔离与撤权/文档失效后的派生内容阻断。
- [ ] WIKI-020：不可信输入/产物、路径、注入和敏感输出治理。
- [ ] WIKI-021：浏览、构建、审核、发布、取消、版本、回滚API。
- [ ] WIKI-022：PG事件、SSE续传与真实阶段进度。
- [ ] WIKI-023：Wiki浏览/搜索/来源与全套异常状态。
- [ ] WIKI-024：真实页面级进度、报告、审核、过期和同步管理。
- [ ] WIKI-025：指标、Trace、脱敏日志、告警及Runbook。
- [ ] WIKI-026：单元、外部契约、集成和E2E回归。
- [ ] WIKI-027：第三方编译质量、外网Golden与内网语料验收。
- [ ] WIKI-028：编译器原理、Adapter、BullMQ/PG、调试与面试教学。
- [ ] WIKI-029：Node24、依赖锁定、Compose、镜像和完全离线验证。
- [ ] WIKI-030：变更清单与SHA核对；依实施轮次要求增量同步diff，包含测试。
- [ ] WIKI-031：内网Wiki Source/Publisher Port与能力快照。
- [ ] WIKI-032：页面/附件稳定身份和现有外部导入链。
- [ ] WIKI-033：变化、删除、游标及权限收缩同步。
- [ ] WIKI-034：来源ACL等价或更严格映射，未知权限隔离。
- [ ] WIKI-035：目标受众核验后异步幂等发布到AI专用目录。
- [ ] WIKI-036：部分失败恢复、晚到发布防护、逐页和版本对账。
- [ ] WIKI-037：远端条件写、人工编辑冲突和无条件写平台降级。
- [ ] WIKI-038：专用目录、绑定ID、元数据防止循环回灌。
- [ ] WIKI-039：平台探测、映射、同步、冲突与真实状态界面。

### 编译器优先的新增需求

- [ ] WIKI-040：完成真实发布包的SDK能力验证报告，锁定上游版本/commit/integrity。
- [ ] WIKI-041：Node24独立执行器、结构化协议、资源预算与离线运行。
- [ ] WIKI-042：WikiCompilerPort/Adapter，默认真实调用第三方编译内核。
- [ ] WIKI-043：稳定来源导出、行号source-map、截断检测和来源包Hash。
- [ ] WIKI-044：原始编译产物收集、review路径验证、规范化转换与未知引用拒绝。
- [ ] WIKI-045：GLM桥接或Provider注入、tool_calls兼容、总预算与取消验证。
- [ ] WIKI-046：页面进度所需上游扩展/最小补丁，具备回归与升级记录。
- [ ] WIKI-047：编译缓存快照、跨Worker恢复、删除清理及版本升级兼容矩阵。

## 14. 实施批次与门禁

| 批次                 | 交付                                                | 主要需求                     | 门禁                                   |
| -------------------- | --------------------------------------------------- | ---------------------------- | -------------------------------------- |
| 一：编译器集成验证   | 锁定包、最小真实SDK执行、中文产物、能力/差距报告    | 040及041～047可行性          | 第三方真实编译成功，不能用Mock结果替代 |
| 二：编译执行底座     | Port、Node24进程、GLM桥接、来源包、Artifact、PG租约 | 001～006、040～045           | 超时/取消/崩溃恢复与来源可追溯         |
| 三：编译产物与治理   | 目录页面转换、Lint/Eval、语义审核、发布回滚         | 007～013、020、044           | 错引用/条件遗漏/过时来源不发布         |
| 四：增量、进度与搜索 | 快照复用、删除、并发发布、页面事件、Embedding       | 014～019、022、024、046～047 | 无串空间，无删除残留，无伪进度         |
| 五：API和前端        | Wiki浏览、搜索、原文、审核与管理                    | 021～024                     | 权限和异常状态E2E                      |
| 六：内网Wiki平台     | 来源导入、目标同步、冲突和防回灌                    | 031～039                     | 两端ACL、并发写和部分失败验证          |
| 七：生产交付和教学   | 全量回归、质量基线、离线部署、文档、diff            | 025～030                     | 外网交付与内网验收分开记录             |

所有批次先完善对应ADR/需求，规则测试先行。代码、测试、可观测性、文档、验收齐备才能勾选。
首批若发现核心能力无法适配，提交有复现证据的方案调整，不越过门禁开发依赖模块。

首批合成语料至少包括：同名主题不同含义、跨文档概念、制度金额/适用日期/例外、矛盾版本、
长文档/表格、增删改、恶意指令和两个隔离空间。对比首次编译和增量后的页面、引用、调用次数与耗时。
GLM真实内网联调单列待验收；外网模型通过不等于GLM通过。

## 15. 测试与质量验收

编译器契约测试覆盖正常、超时、取消、Schema错误、429/5xx、版本不匹配和部分失败。
额外覆盖review候选不可导出、输出截断、路径逃逸、非法编码、输出过大、被杀进程和不完整工作区。

来源映射测试覆盖重叠Chunk、标题改名、行号变化、无行号引用、跨文档/版本/空间伪造引用。
语义质量测试单独判断否定、条件、例外、有效日期和矛盾，禁止将“有引用”当作“受原文支持”。

PG/BullMQ测试覆盖Outbox重投、多Worker竞争、续租失败、取消与完成竞态、Head CAS、
编译完成但入库失败、索引部分写入、队列丢失后补投、编译产物在另一Worker恢复。
删除/撤权测试覆盖正文、目录、摘要、搜索、缓存及远端镜像。

前端和E2E覆盖上传→Manifest→真实编译器→审核→Wiki→修改/删除→增量→远端同步。
网络隔离启动测试确认无npm下载、模型下载、公有API和编辑器登录依赖。

质量报告记录概念合并精度、主题覆盖、重复页、断链/孤儿、引用身份正确率、语义支持率、
过期/删除残留、编译时长、LLM用量、增量复用率和普通RAG延迟回归。
结构身份、越权、删除残留属于强制零违规门禁；语义质量及耗时阈值在试点前登记并由真实语料验证。
内网质量验收未完成时不启用自动发布，也不标记生产全部完成。

## 16. 可观测性、教学和代码落点

记录Build/attempt、编译器版本/补丁、workspace/artifact Hash、节点耗时、模型调用量、
退出原因、引用移除原因、审核结果和Head切换。日志不记录正文、密钥和完整提示词。
阶段事件和心跳由父进程写PG；库的stdout/stderr不能直接转发给用户。
告警包含队列积压、模型超时、磁盘预算、租约失效、来源过时、对账失败、远端同步滞后。

| 位置                                                  | 职责                                     |
| ----------------------------------------------------- | ---------------------------------------- |
| libs/contracts/src/wiki\*.ts                          | Zod、页面、编译协议与同步契约            |
| libs/wiki/src/                                        | 状态、来源复核、发布规则；不复制编译算法 |
| libs/application/src/wiki\*.ts                        | Use Case与Port                           |
| 独立packages/wiki-compiler-runner/                    | Node24/ESM入口、真实SDK、受控依赖和补丁  |
| libs/persistence-pg/src/postgres-wiki\*.ts            | 生命周期、Artifact、审核、Head与同步     |
| libs/persistence-redis/src/                           | BullMQ投递与事件适配                     |
| libs/model-gateway/src/                               | 编译模型桥接/Provider适配                |
| libs/rag-graph/src/wiki-generation.graph.ts           | 外层编译任务流程                         |
| apps/ingestion-worker/src/wiki-generation/            | 执行器生命周期、并发和取消               |
| apps/platform-api/src/wiki/                           | 读取、审核、发布与同步接口               |
| libs/wiki-platform-gateway/src/                       | 具体内网Wiki平台Adapter                  |
| apps/scheduler-worker/src/wiki-platform/              | 同步与恢复补偿                           |
| apps/web-console/src/features/wiki/                   | 浏览、管理、引用与事件                   |
| docs/learning/wiki-generation-code-walkthrough.md     | 从原文到编译器再到PG的逐步教学           |
| docs/runbooks/wiki-generation.md                      | 缺引用、编译慢、取消失败、冲突与恢复     |
| docs/acceptance/wiki-compiler-integration-evidence.md | 发布包能力与补丁验证证据                 |
| docs/acceptance/wiki-generation-acceptance.md         | 功能、质量及内网验收                     |

中文JSDoc标明需求编号和职责。教学明确“上游算法如何工作、我们接了什么、什么要自己负责”，
包括两阶段概念抽取、增量依赖、引用精度、编译缓存与PG事实区别、模型与程序各自判断边界、选型及面试追问。

## 17. 上线和交付完成定义

1. 首批通过后锁定包与补丁，安装/编译在外网构建阶段完成。
2. 部署新增迁移和编译执行器，Wiki默认关闭。
3. 单一测试空间手工构建、审核发布，对照原文验证。
4. 验证增量删除、撤权、取消、恢复和原始RAG回归。
5. 分别开启自动构建、Wiki读取、远端拉取和远端发布；远端真实契约验收独立记录。
6. 故障关闭相关开关；工作区保留策略和本地发布事实互不替代。
7. 版本升级先在副本工作区跑兼容与质量回归，不能直接迁移唯一生产缓存。

本阶段完成要求WIKI-001～047全部具备代码、测试、可观测性、文档和验收证据。
“核心Wiki完成”和“内网平台真实Adapter待联调”必须分别报告；平台资料缺失不能伪装为已适配。
最终交付包括锁定第三方内核、可维护补丁、六镜像或经ADR确定的运行方式、离线依赖清单、
环境变量说明、源码/测试增量清单和完整学习材料。
