# 07：结合本项目的企业级 RAG 面试与连续深挖

## 1. 回答方法：不要背名词

一个有落地感的答案按四层讲：

1. 先给结论：我选择什么，解决什么业务风险。
2. 再讲链路：数据怎样流、状态怎样变。
3. 给项目证据：具体表、事件、Graph 节点、指标或真实故障。
4. 最后讲取舍：什么情况下会换另一种方案。

例如不要只说“用了混合检索”。应该说：

> 企业文档既有同义表达也有制度编号和金额，所以我们并行 Dense/Sparse，用 Weighted RRF 合并不同量纲的排名，再做 PG 权限复核、每文档/章节多样性和专用 Reranker。中型规模默认先召回 40、最终 12，但通过 Golden 按问题类型调参；如果是纯商品编码库，我会优先倒排和结构化查询而不是强上 Dense。

## 2. 项目总览类

### Q1：请介绍你做的企业级 RAG

参考回答：本项目面向单企业内网，管理面和查询面分离。入库通过预签名上传、PG 事务与 Outbox、BullMQ Worker、安全解析/选择性 OCR、结构化 Parent/Child Chunk、质量门禁、Embedding、Milvus 候选索引和 Manifest 对账发布；问答冻结权限和模型/索引快照，用两层 LangGraph 完成查询规划、Dense/Sparse、RRF、PG 回源、Rerank、Evidence、结构化生成、Citation 和 Validator。基础设施可通过 Port/Adapter 由外网 Fixture/DeepSeek 切到内网 LLM、BGE、PaddleOCR、Milvus。

追问：为什么叫企业级？

答：不是因为用了多少组件，而是覆盖权限默认拒绝、版本可复现、幂等恢复、可观测、发布回退、质量评测、数据生命周期和离线部署。

### Q2：最大难点是什么

可以选择三个讲透：跨 PG/Redis/MinIO/Milvus 的一致性；权限与缓存/向量索引的正确性；模型与索引版本可复现；证据冲突/引用校验；离线 Provider 契约。

不要回答“LangGraph API 难”。框架 API 是学习成本，不是核心工程难点。

### Q3：为什么拆 Platform API 和 Query Service

管理面包含上传、审核、评测和治理，流量低但任务重；查询面延迟敏感、并发更高。拆开可独立扩容、限流、发布和隔离故障域。中小系统也可先单体模块化，但保持 Domain/Application 边界，达到流量阈值再拆进程。

### Q4：为什么不用微服务拆得更细

服务边界会带来网络、部署、契约和一致性成本。本项目只拆资源模型和 SLA 明显不同的进程，业务模块仍共享 monorepo Contract；避免为了“微服务”把每张表拆一个服务。

## 3. 文档接入与异步任务

### Q5：大文件上传为什么用预签名和 Multipart

API 只负责授权和元数据，字节直达 MinIO；Multipart 局部重试。Complete 响应未知时先 HEAD 外部事实，再决定补事务，避免重复合并。

追问：预签名 URL 泄漏怎么办？

答：短 TTL、限对象/方法、随机 Key、HTTPS、日志脱敏、完成后生命周期控制；Parser/OCR 也只获得短时 GET，不拿永久账号。

### Q6：为什么用 Outbox，不直接 API 发 BullMQ

PG 和 Redis 没有共同事务。先发队列可能出现幽灵任务，先写 PG 后进程崩溃可能漏任务。事务内写 Outbox，Scheduler 至少一次投递；消费者通过稳定 Job ID、Receipt、唯一约束和状态机幂等。

追问：Outbox 会不会重复？

答：会，设计上接受重复、拒绝丢失。Exactly Once 是业务效果，不是消息传输承诺。

### Q7：BullMQ 已有锁，为什么还要 PG Lease

BullMQ 锁控制一次 Redis Job 的消费者；PG Lease 控制业务状态写权限，能覆盖长远程调用、队列状态丢失、接管和迟到结果。旧 Worker leaseOwner 不匹配时不能覆盖新结果。

### Q8：Worker 崩溃后怎么恢复

BullMQ 检测 stalled/retry，PG Lease 到期可被重新领取；每个步骤读取已持久化状态，外部副作用用稳定 ID/HEAD/upsert 查询；不会从内存猜上次做到哪里。

### Q9：为什么上传进度可信

进度由每个 Job Step 的真实完成单位和权重计算，写入 PG Event；SSE/ETag Poll 展示。调用 Parser/OCR 时只续租，不伪造百分比。刷新后从 PG 恢复。

## 4. Parser、OCR 与 Chunk

### Q10：为什么不能只看文件扩展名

扩展名和 MIME 可伪造。需要 Magic Bytes、OOXML ZIP 结构、宏/外链/嵌入对象、压缩比、页数/像素/单元格上限。解析异常默认不能当 CLEAN。

### Q11：OCR 为什么选择性执行

原生文本通常比 OCR 准且便宜。按页/区域覆盖率选择目标，低覆盖页 OCR，可靠页保留 Parser；Office 内嵌图片用 targetId 定位。能显著降低 GPU/延迟并避免好文本被覆盖。

### Q12：Chunk 大小怎么确定

先按结构和用途设计，再用 Golden 调 Token。Child 要精确召回，Parent 提供上下文；表格保留表头和行列，标题注入 Child。通过 Recall、重复率、答案正确率、索引成本联合判断，不存在通用 500 Token 最优值。

追问：Overlap 越大越好吗？

答：不是。它减少边界丢失，也增加索引、Embedding 成本和重复霸榜，需要多样性约束；结构感知边界通常比盲目加 overlap 更有效。

### Q13：Parser 为什么不直接输出 Chunk

Parser 负责忠实恢复文件结构，Chunk 负责面向检索的知识组织。两者版本和评测目标不同；拆开后更换 Chunk 策略无需重新解析字节，也能保留原始 Block 审计。

## 5. Embedding、检索和排序

### Q14：Embedding 模型怎么选

看语言、领域、长文本、Dense/Sparse、维度、吞吐、GPU、许可证和内网服务契约。用企业问题/证据集测 Recall@K，不只看公开榜单。BGE-M3 适合中英和 Dense/Sparse 是候选，不代表未经本地评测就一定最佳。

### Q15：为什么 Query 和 Document 模板要区分并版本化

很多检索模型对 query/document 使用不同前缀或指令。模板变化会改变向量空间；如果只更新查询端，旧文档向量不兼容。模板版本应进入 Profile，变化后重建索引。

### Q16：为什么使用混合检索

Dense 处理语义同义，Sparse 处理编号、专名、金额和原词。RRF 按排名融合，避免直接相加不可比的分数。再用字面量、权限回源、多样性和 Reranker 完成企业检索。

### Q17：RRF 和归一化加权有什么取舍

RRF 稳健、无需校准不同分数分布，适合多 Provider；缺点是不利用分数间距。若有稳定标定集，可做 score normalization/learning-to-rank，但模型升级后需重校准。本项目先用可解释 RRF。

### Q18：TopK 如何调

Initial TopK 决定召回，Final TopK 决定模型成本。按 Recall@K 曲线、Reranker 上限、文档重复和延迟联合选择。TopK 过小漏证据，过大增加噪声/成本；本项目中型默认 initial 40、final 12，是基线不是真理。

### Q19：为什么 Milvus 后还要回 PG

Milvus 元数据是发布时快照，权限/状态可能已变化；Filter 也可能受索引残留影响。PG 是当前授权和文档版本真相，回源复核是防越权最后边界。

### Q20：Embedding 换模型如何无损上线

建立不可变新 Profile，新 Collection 全量构建，Expected/Actual/Hash/Profile 对账，Golden 达标后建立 Canary，按稳定用户分桶，观察 Recall/答案/延迟，管理员 Promote 原子切 Manifest Head。异常回 previousManifest，旧集合按保留策略延迟清理。

### Q21：Milvus、pgvector、Elasticsearch 怎么选

- 小规模、团队熟 PG、过滤简单：pgvector 降低运维。
- 关键词/过滤/全文为主：Elasticsearch/OpenSearch。
- 向量规模和吞吐高、独立索引生命周期：Milvus。
- 很多企业最终是结构化 SQL + Search + Vector 多路召回，而不是单选。

结合规模、SLA、运维能力和已有平台选择，不能只比 benchmark。

## 6. 证据、生成与校验

### Q22：Reranker 和 LLM 有什么区别

专用 Reranker 对 query-document 相关性打分，便宜、稳定；LLM 负责理解复杂指令和生成，成本高且非确定。LLM Evidence Rerank 只用于复杂证据判断，不替代主 Reranker。

### Q23：如何降低幻觉

不是一句“Prompt 要求基于知识库”：先保证高 Recall 和权限正确；Evidence Bundle 限制材料；证据不足/冲突路由；结构化 Claim + Citation 白名单；关键字面量/计算规则校验；可选语义 Judge；低置信拒答；Golden 持续评测。

### Q24：Citation 怎么保证不是模型编的

服务端预先为 Evidence 生成允许 ID，模型只能从白名单引用；生成后重新验证 ID、来源 Hash、Run Snapshot、Claim 覆盖和当前访问权限。Citation 详情接口再次授权。

### Q25：证据冲突怎么判断

先限定同一 subquestion、同一可比事实位置，再比较不同有效版本/来源的字面量和语义。不能看到多个数字就冲突。本项目曾把住宿 650、审批 5000/20000、时限 10 天误判为冲突，修复后新增回归测试。

### Q26：什么时候必须拒答

关键证据缺失、有效来源冲突未解决、引用无法验证、权限不确定、高风险 Validator 不可用、问题命中安全策略。拒答要给可行动原因，如需要补充范围或联系制度负责人，而不是统一“我不知道”。

### Q27：LangGraph 和普通 Pipeline 怎么选

固定无分支链路用普通函数更简单。存在路由、有限循环、重试、人工节点、取消、checkpoint 和逐节点观测时 Graph 更清晰。本项目有两个有限状态图，但不使用开放式无限 Agent，保证成本和行为上限。

### Q28：如何控制 Token 和成本

检索先裁剪，多样性和 Reranker 后只保留高价值证据；Context Builder 按 token 预算、每文档上限和证据等级装箱；使用 Parent 选择性扩展；缓存 Query Embedding；限制再生成次数；按问题复杂度跳过 Rewrite/Judge。

## 7. 安全、合规和生产

### Q29：如何防数据越权

trusted auth context、角色映射、Space ACL 默认拒绝；服务端编译 Milvus Filter；PG source recheck；缓存 Key 包含授权版本；Citation 再授权；API 不接收用户 role/SQL/objectKey；审计所有权限变更。

### Q30：如何防 Prompt Injection

文档视为不可信数据，系统规则和证据边界分隔；模型不直接决定工具/权限/Filter；只允许白名单 Citation；输入/输出策略、工具参数 Schema、敏感操作人工审批；测试集中包含恶意文档和问题。

### Q31：敏感问题为什么加密保存

数据库泄漏或普通运维查询不应直接看到问题正文。Run Content 用 AES-256-GCM，密钥由 Secret 注入并支持保留/删除策略；日志、Trace、指标不记录正文。加密不能替代访问控制和密钥管理。

### Q32：如何做 RAG 评测

分层评测解析、检索、生成和生产：解析结构/OCR；Recall@K/MRR/NDCG/权限；Faithfulness/Citation/拒答；P95/吞吐/成本/降级。数据集覆盖正常、无答案、冲突、数字、表格、多跳、权限和 Injection。发布与 Baseline 分维度对比。

### Q33：如何做容量规划

从日上传量×平均页/Chunk 得到 Embedding 吞吐和向量增长；从问答 QPS×TopK×Rerank/LLM 调用算 Provider 并发；用 P95/P99 和峰值系数确定副本；同时估 PG 连接、Redis 队列年龄、MinIO 容量、Milvus segment/index 内存。真实 k6/Soak 修正估算。

### Q34：Redis 挂了会怎样

Cache Redis 挂：安全绕过缓存，性能下降。BullMQ Redis 挂：新任务不投递，PG Outbox 保留，恢复后续发；运行中的业务状态仍在 PG。Run Stream 挂：SSE 降级 Poll/稍后恢复。必须告警，不能把“最终能恢复”当成无影响。

### Q35：Milvus 挂了会怎样

入库候选构建失败但不切 ACTIVE；查询按政策重试/熔断并拒答或降级到可用 Sparse/其他搜索。SDK 构造连接失败也要收在 await 边界。本项目因此增加 `__SKIP_CONNECT__` 回归。

### Q36：数据库迁移怎么避免停机

Migration 有 checksum/advisory lock；采用 Expand-Contract，新列/表先兼容旧应用，回填后切新应用，再删除旧结构。Compose 用一次性 migrate Job，成功后应用启动；多副本不能各自无序迁移。

## 8. 企业场景设计题

### 场景 A：银行制度库，答错风险高

选择：空间/文档细粒度 ACL，结构化条款 Chunk，Dense+Sparse+字面量，专用 Reranker，Evidence/引用强校验，Semantic Judge 不可用时 fail-closed，人工升级，完整审计和较高拒答率。模型延迟让位于正确性。

### 场景 B：制造业设备维修，文档扫描和表格多

重点不在换更大 LLM，而在版面/OCR、表格、图片说明与设备型号精确召回；按设备/版本元数据过滤，错误码用 Sparse，维修步骤用 Dense，答案引用页码和图号。现场弱网可做短缓存，但权限和版本仍复核。

### 场景 C：客服 FAQ，QPS 高、风险中等

高频问题可做语义缓存，轻量 Embedding/Reranker，答案模板化，低置信转人工；关注 P95、缓存授权版本、热点和反馈闭环。简单 FAQ 不必每次跑完整 Semantic Judge。

### 场景 D：代码知识库

按符号/文件/调用关系 Chunk，结合 lexical code search、AST/依赖图和 Dense；权限随仓库；引用到 commit/path/line。只用自然语言向量会漏精确函数名和版本。

### 场景 E：跨部门多知识域

先做 Query Routing 和受权 Space 缩小，再域内检索；不能全库召回后才过滤。每域可有不同 Chunk/Embedding Profile，但跨域问题需要统一 Evidence 和权限策略。

### 场景 F：实时更新的政策/行情

区分知识库与实时数据。静态制度走 RAG，实时数值走受控 API/SQL Tool 并在答案中标时间戳；不能把小时级索引当实时事实。对时效性设置过期路由。

## 9. 面试官常见“陷阱”

- “上了向量库就不用数据库”：错误，向量库不擅长事务、授权和业务状态。
- “用了 Reranker 就一定更准”：必须用本地数据证明提升与成本。
- “Outbox 就 Exactly Once”：传输仍可能重复，消费者业务幂等才得到一次效果。
- “温度设 0 就完全确定”：模型和底层实现仍可能非确定，必须快照和评测。
- “Chunk 越小召回越准”：上下文和表格关系会丢，索引也膨胀。
- “内网所以 trusted header 天然安全”：若后端可直连或代理不清洗 Header，仍可伪造。
- “换模型只改 MODEL_ID”：Embedding/Tokenizer/模板变化需要新 Profile 和重建索引。
- “没有答案是系统失败”：高风险场景正确拒答是质量指标。

## 10. 你的三分钟项目陈述

> 我落地的是单企业内网中型规模 RAG。设计时我把离线知识生产和在线答案生产分开，并让 PostgreSQL 成为唯一事实源。上传用 MinIO 预签名和 Multipart；Job、Step、Event 与 Outbox 同事务落库，BullMQ 至少一次交付，Worker 通过稳定 ID、Inbox、Lease 和状态机幂等。文件先安全识别，再由九类 Node Parser 和选择性 PaddleOCR 统一成可定位 Block，做 Parent/Child Chunk、质量门禁和批量 Embedding。向量写候选 Milvus Collection，数量、主键、Hash 和 Profile 对账后才原子发布 Manifest。
>
> 查询时 Run 冻结 userId/roles、空间、Manifest、模型、Prompt 和 Policy。LangGraph 先做 Query Route/Plan，Dense+Sparse 召回后用 Weighted RRF、PG 回源权限复核、多样性和 Reranker；再建立 Evidence Bundle，根据不足/冲突/敏感路由，按 Token 预算生成结构化 Draft，并校验 Citation 白名单、关键 Claim、规则和可选语义蕴含。PG 存真相，两个 Redis 分别做 Cache 和 BullMQ/Stream，MinIO 存字节，Milvus只做召回。
>
> 项目支持外网 Fixture/DeepSeek 和内网 HTTP Provider 的配置切换。真实联调中我们修过 Milvus SDK 初始化未处理连接、中文 VARCHAR 字节上限、跨章节数字误判冲突和取消事件毒队列，并补了回归。上线前还需要在真实内网完成 Provider Golden、长稳、Chaos、RPO/RTO 和容量验收。
