# 12：企业级 RAG 面试连续深挖与高分回答

> 第 7 章是快速复习题，本章是面试训练正册。每组题都包含：面试官在判断什么、第一层回答、连续追问、换场景和项目证据。练习时先遮住答案，连续讲 3～8 分钟，再按评分标准纠正。

## 1. 什么回答才像真正落地过

### 1.1 五档评分

| 档位    | 回答特征                             | 面试官感受             |
| ------- | ------------------------------------ | ---------------------- |
| 1：名词 | “用了向量库、Reranker、LangGraph”    | 看过文章，没有落地证据 |
| 2：流程 | 能讲上传、切片、检索、生成           | 做过 Demo，但边界不清  |
| 3：工程 | 能讲事务、幂等、权限、版本、错误分类 | 参与过可运行系统       |
| 4：生产 | 能讲 SLO、容量、观测、回滚、真实故障 | 有企业落地能力         |
| 5：架构 | 能根据新场景删减/替换设计并给指标    | 能主导方案而非只执行   |

你的目标不是把每个问题回答得最长，而是稳定达到 4，并在选型题达到 5。

### 1.2 高分回答的七个元素

1. 场景与约束；
2. 明确结论；
3. 数据/状态执行链路；
4. 失败窗口或安全风险；
5. 项目中的具体实现；
6. 测试、指标和验收；
7. 条件变化后的演进。

### 1.3 不要编造生产数字

这个项目当前完成了本地/容器/合成 Golden 验收，但真实内网 Provider、业务数据和生产流量仍需现场验收。正确表达：

> 代码门禁和中型默认 Profile 已完成；后端 306 个、前端 10 个自动化测试通过。具体业务 Recall、P95 和容量不会拿本地合成数据冒充生产成绩，进内网后要用脱敏 Golden、压力/长稳和 RPO/RTO 演练确定。

诚实区分“设计目标、测试结果、真实生产结果”，比编一个夸张 QPS 更专业。

---

## 2. 项目介绍：30 秒、3 分钟、15 分钟

### 2.1 30 秒版本

> 我做的是单企业内网、中型规模的完整 RAG 平台。离线侧完成多格式文件安全解析、选择性 OCR、结构化 Chunk、质量审核、Embedding、Milvus Candidate 构建和 Manifest 原子发布；在线侧用受控 LangGraph 做查询规划、Dense/Sparse、RRF、PG 权限回源、Reranker、Evidence、结构化生成和 Citation 校验。PG 是事实源，BullMQ 只做异步调度，模型和存储都经 Port/Adapter 支持外网到内网配置切换，并交付无公网 Docker 镜像包。

### 2.2 3 分钟版本的结构

按“背景 → 两条链 → 三个难点 → 结果与边界”讲：

1. 背景：内网、userId/roles、多格式、模型服务由内网提供、要求可学习和可部署。
2. 离线链：上传到 Manifest 发布。
3. 在线链：Run Snapshot 到 FinalAnswer。
4. 难点一：PG/Redis/MinIO/Milvus 一致性，用 Outbox/Lease/Manifest。
5. 难点二：权限和版本，用 Filter/PG 回源/快照/Citation 再授权。
6. 难点三：幻觉与证据，用 Evidence/Validator/有限图。
7. 结果：代码测试、离线构建、Provider 契约；说明内网真实验收尚待现场完成。

### 2.3 15 分钟版本

面试官让画架构时，用两条泳道：

```text
知识生产：Web → Platform API → MinIO/PG Outbox → BullMQ Worker
        → Parser/OCR → Chunk/Quality → Embedding/Milvus → Manifest Head

答案生产：Web → Query Service → Run Snapshot → Retrieval Graph
        → Answer Graph → PG Citation/Validation → SSE/FinalAnswer
```

然后在图边上标：事实源 PG、派生存储 MinIO/Milvus/Redis、权限边界、版本边界、失败恢复点。不要花十分钟只画组件 Logo。

---

## 3. 总体架构连续追问

### 题组 1：为什么这叫企业级 RAG，而不是高级 Demo？

**面试官在判断**：你是否知道企业级来自系统保证，而不是组件数量。

**高分回答**：

> Demo 通常证明“给一份文档能回答”；企业系统要证明谁能看、用了哪个版本、失败能否恢复、答案依据是什么、如何回滚和运营。本项目覆盖身份/Space ACL、文件安全、异步幂等、Profile/Manifest/Run Snapshot、混合检索、Evidence/Citation Validator、审计指标、评测、备份恢复和无网络部署。Milvus 和 LangGraph 只是实现手段。

**追问 1：选三个最重要亮点。**

不要罗列十个。建议选：

1. `PG 事实源 + Outbox/Lease/幂等`，解决跨系统失败恢复；
2. `不可变 Manifest/Profile + Run Snapshot`，解决知识和模型升级可复现/回滚；
3. `权限收窄 + Evidence/Citation Validator`，解决企业越权和幻觉。

根据岗位也可把全格式 Parser/OCR 或离线 Provider 包作为第三个。

**追问 2：这些是不是过度设计？**

> 对个人知识库是过度设计，所以可以删掉多角色 ACL、独立 Milvus、多进程和复杂发布；但当前目标是中型企业内网，文件任务会跨分钟、权限会变化、模型会升级，因此失败恢复和版本边界不是装饰。是否过度要看风险和规模，而不是看代码行数。

**项目证据**：`docs/requirements`、`space_manifest_heads`、`rag_runs.snapshot`、`outbox_events`、`answer_validation_reports`。

### 题组 2：为什么 Platform API、Query Service、Worker、Scheduler 要拆开？

**第一层回答**：管理面低频但操作重；查询面延迟敏感；Worker 处理长任务；Scheduler 负责恢复和周期工作。独立进程允许分别扩容、限流和隔离故障。

**追问 1：为什么不全部微服务？**

> 服务边界带来网络、部署、契约和一致性成本。我们按资源/SLA/故障域拆进程，领域模块仍在 Monorepo 共享 Contracts，不按每张表拆服务。如果团队或合规域真正独立，再进一步拆。

**追问 2：流量很小怎么办？**

> 可以合并 API/Query 进程，甚至用 PG 任务表替代 BullMQ，但保留 Domain/Application/Port 边界。架构能力可以收缩，业务不变量不能丢。

**追问 3：Query 扩 10 个副本有什么新问题？**

> PG 连接总数、LLM/Reranker 并发、Redis 全局/用户限流、SSE 路由和 Run Scheduler 领取竞争都要重新预算。水平扩容应用不代表下游容量自动增加。

### 题组 3：为什么使用 Clean/Hexagonal 风格？

**高分回答**：

> 业务规则如权限交集、Manifest 状态、RRF、Validator 生命周期比供应商 SDK 更稳定，所以放在 Domain/算法库；Application 只依赖 Port；Nest、PG、Redis、Milvus 和模型 SDK 放 Adapter。这样外网 Fixture、DeepSeek 与内网 Provider 切换时不改业务规则，也能在 Unit Test 中注入失败。

**追问：有什么代价？**

> 接口、映射和 DI 代码更多，简单 CRUD 可能显得重；所以只为真正外部边界和稳定业务能力建 Port，不为每个函数造抽象。

**追问：Domain 为什么不能依赖 Prisma/Nest？**

> 否则业务不变量会被框架生命周期和数据库实体形状绑死，单测必须启动基础设施，供应商字段还会向内渗透。

---

## 4. 契约与内网适配连续追问

### 题组 4：为什么 TypeScript 类型还要 Zod？

**回答**：TypeScript 只在编译期约束本项目源码，HTTP JSON、ENV、数据库 JSONB 和队列消息在运行时仍不可信。Zod 在边界拒绝缺字段、错误枚举和越界数值，避免错误进入业务深处。

**追问：所有层都反复 Zod 吗？**

> 重点在不可信边界：Controller、Provider、Event、ENV、持久 JSON。内部已经由类型和构造器保证的不变量不必每行重复解析，否则增加噪声和成本。

**追问：Schema 变更怎么办？**

> 兼容新增字段可做向后兼容；破坏性变更提升 protocol/event version，消费者支持过渡版本或先升级 Reader 后 Writer，记录 ADR 和 Contract Test。

### 题组 5：带入内网是不是只改 ENV？

**高分回答**：

> 仅当内网 Provider 满足契约时成立。URL、Key、modelId、revision 不同改 ENV；字段结构不同写 Adapter/Gateway；能力不同则重新选型。例如 Embedding 维度/模板变化要新 Profile 和重建索引，不能靠 ENV 把旧向量变兼容。项目给了 Provider HTTP 契约、启动 metadata 校验和无网络 images.tar。

**追问：PaddleOCR 返回字段不同怎么办？**

> 在 `HttpOcrAdapter` 或内部网关把 Paddle 的 bbox/text/confidence 转换为项目 target/block 契约，处理页码坐标系、旋转、confidence 范围和 revision；用 Golden 图片做 Contract Test。不要让 Paddle 字段散落进 Application。

**追问：OpenAI-compatible 就完全兼容吗？**

> 不一定。需要验证 Base URL 拼接、鉴权 Header、JSON Schema、流式格式、finish reason、超时/取消、错误码、max tokens 和模型 revision。名称兼容不等于行为兼容。

### 题组 6：Deadline、Timeout 和重试如何配合？

**回答**：总 Run 有 Deadline；每次 Provider 调用有更短 Timeout；AbortSignal 传播取消。重试前计算剩余预算，指数退避加 jitter，只有 retryable 错误重试，次数有限。

**追问：为什么 429 能重试，Schema 错误不能？**

> 429 是暂时容量问题；Schema 错误表示契约不兼容，同样请求重放不会变好，只会制造重试风暴。

**追问：模型实际完成但客户端 timeout 怎么办？**

> 对无幂等查询可安全重新调用但会重复成本；对有副作用的远程操作必须使用 idempotency key 或查询外部事实。整体仍受 Deadline 和 attempt 记录约束。

---

## 5. 文档接入、BullMQ 和一致性连续追问

### 题组 7：为什么大文件走预签名上传？

**回答**：API 只做授权和元数据，字节直达 MinIO；避免 Node API 占内存/带宽，Multipart 可局部重试。对象 Key 服务端生成，URL 短 TTL、限对象/方法，日志脱敏。

**追问：浏览器说上传失败，但对象其实成功了？**

> Complete 响应丢失时先 HEAD 对象的 size/hash，再补记 PG；不能盲目重复 Complete。这是处理“外部已成功、本地未知”的不确定窗口。

**追问：MinIO 成功，PG 事务失败，孤儿对象怎么办？**

> 上传会话/对象带受控前缀和生命周期，补偿任务按 PG 引用对账清理孤儿；不能在事务回滚时假定同步删除一定成功。

### 题组 8：为什么用 Outbox？请讲完整，不要只说最终一致性。

**高分回答**：

> PG 和 Redis 没有共同事务。先发队列后提交 PG 会产生幽灵任务；先提交 PG 后发队列，进程可能在中间崩溃导致漏任务。我们在业务事务内写 Job、Event 和 Outbox；Scheduler 用租约/批量领取并发布 BullMQ，成功后标记 published。发布后标记前仍可能崩溃，因此传输至少一次；消费者用稳定 Job ID、Receipt、唯一约束、状态机和 PG Lease 保证重复业务效果幂等。监控 pending 数和 oldest age，失败进入重试/DLQ/人工处理。

**追问：那是 Exactly Once 吗？**

> 消息传输不是，仍可能重复；我们追求的是 Exactly-once business effect。把二者混为一谈是不严谨的。

**追问：Outbox 表会无限长吗？**

> 需要分批发布、索引 pending、按保留/审计要求归档或清理；监控积压年龄。不能删除仍未发布或仍在恢复窗口内的数据。

### 题组 9：BullMQ 已经有 Lock，为什么还有 PG Lease？

**回答**：BullMQ Lock 管 Redis Job 的消费者，PG Lease 管业务记录写资格。A 卡住后 Lock/Lease 到期，B 接管；A 迟到返回时 PG 用 `leaseOwner/leaseUntil` 条件更新拒绝它，避免覆盖 B。

**追问：Lease 多长合适？**

> 大于正常心跳间隔和瞬时抖动，小于可接受接管时间；长远程调用期间续租。用 P95/P99 阶段耗时和故障恢复目标确定，不拍脑袋。Lease 过短会误接管，过长会延迟恢复。

**追问：系统时间漂移怎么办？**

> 以数据库时间作为 Lease 判断基准，节点做 NTP；不要各 Worker 用本地时钟互相比较。

### 题组 10：任务重试怎样避免重复向量和重复事件？

**回答**：事件有幂等键/Receipt；Chunk ID 稳定；vectorId 由 Manifest、Chunk、Embedding Profile 稳定计算；Milvus Upsert；PG Unique 防并发重复；状态机拒绝终态回退。每个外部副作用都要问“调用成功但本地没记录怎么办”。

**追问：所有接口都能 Upsert 吗？**

> 不能时要用供应商幂等键、创建前查询或补偿/对账。不能把“我们会重试”当作可靠性方案。

---

## 6. Parser、OCR 和 Chunk 连续追问

### 题组 11：为什么 Parser 不能只输出纯文本？

**回答**：企业答案要保留标题、表格、页码、坐标和图片定位。纯文本会丢语义关系和可引用位置。项目统一为 Block，Parser 忠实恢复，Chunker再按检索目标组织。

**追问：Parser 和 Chunker 合并不是更快吗？**

> 两者版本和目标不同。拆开后调 Chunk 不必重新读取不可信字节，也可对 Parser Artifact 做审计和多种 Chunk Profile A/B。

**追问：Parser 更新会发生什么？**

> 新 Parse Profile/Revision 产生新 Artifact，重新做 Chunk/质量/索引，不能静默覆盖旧结果；对 Golden 格式做结构回归。

### 题组 12：为什么不全量 OCR？

**回答**：原生文本更准、更便宜；OCR 会误识别数字并制造重复。按页/区域覆盖率选择低文本目标，保留 Parser 的可靠区域，OCR confidence 进入质量门禁。

**追问：覆盖率高但文本乱码怎么办？**

> 不能只看字符数量，还要看乱码率、字体映射、语言分布、可见文本与页面区域；必要时路由 OCR。选择策略应由 Golden 扫描/混合 PDF 验证。

**换场景：90% 扫描档案。**

> OCR/版面成为主链，GPU 容量、批量、人工审核和页级重试优先级上升；Node Parser 仍负责容器/metadata，但不能假装原方案参数不变。

### 题组 13：Chunk 为什么选择 Parent/Child？

**回答**：Child 小而精确用于召回，Parent 在命中后补上下文，兼顾召回和生成。标题路径、表头、页码注入，避免孤立数字。

**追问：512/1500/64 怎么定？**

> 是中型通用文档基线。用标准问题/证据比较 Recall@K、重复率、Context Token、答案准确率和成本；按域保存 Profile，不存在万能值。

**追问：Overlap 越大越好吗？**

> 会增加索引/Embedding、重复霸榜和 Context 浪费。结构感知边界往往比盲目 overlap 更有效，项目还有文档/章节多样性上限。

**换场景：商品表 200 万行。**

> 不应先讨论 Chunk 512 还是 1024，而要改用结构化数据库/Search；RAG 用于字段定义和自然语言转受控查询。

---

## 7. Embedding、Milvus 和发布连续追问

### 题组 14：Embedding 模型怎么选？

**高分回答**：

> 先从语言、领域、长文本、Dense/Sparse、维度、Tokenizer/指令、吞吐、GPU、许可证和离线条件筛选；再用企业脱敏 Golden 测 Recall@K、难负例、精确词、延迟和成本。公开榜单只筛候选。模型、revision、dimension、normalize、query/document template、tokenizer 和 sparse format 共同进入不可变 Profile。

**追问：为什么 BGE-M3？**

> 它可能因中英、多功能 Dense/Sparse 成为候选，但必须经内网服务契约和业务 Golden；不能因为流行就称最优。项目支持配置，不把业务绑死某个模型。

**追问：维度越大越好吗？**

> 不一定。更大增加存储、内存、带宽和索引成本；看业务 Recall 增益是否值得。还要与 Milvus Collection Schema 严格一致。

### 题组 15：为什么要 Manifest，而不是给文档加 `active=true`？

**回答**：一次知识发布是整个 Space 的一致快照，不只是单文档状态。Manifest 冻结文档成员、版本、Embedding Profile、Collection 和对账结果；Head 原子指向当前版本。用户不会看到构建到一半的索引，且 Run 可引用具体 Manifest 回放。

**追问：新增一个文档为什么不能只向当前 Collection 插入？**

> 可以设计增量物理写，但逻辑可见性仍要通过新 Manifest/版本边界表达，否则查询期间成员集合、对账和回滚不可证明。本项目优先正确性和可解释发布。

**追问：旧 Collection 何时删？**

> 过回滚/审计保留窗，确认没有活跃 Run、Citation 或 Canary 引用，再由维护任务清理；清理失败不影响 ACTIVE，但要告警和重试。

### 题组 16：换 Embedding 如何无损上线？

**完整回答关键词**：新 Profile；新 Collection；全量构建；expected/actual/PK/hash/profile 对账；Golden baseline；稳定用户 Hash Canary；观察 Recall/答案/P95；管理员 Promote；Head 原子切换；previousManifest 回滚；旧索引延迟清理。

**追问：两个 Profile 维度相同，能共用 Collection 吗？**

> 维度相同不代表向量空间相同。为了防误查和便于生命周期管理，逻辑上必须隔离；是否物理同 Collection 也要用严格 Profile/partition 过滤，但新 Collection 更易证明和回滚。

### 题组 17：Milvus、pgvector、OpenSearch 怎么选？

**回答**：

> 看向量规模/QPS、全文与过滤比重、索引生命周期、团队已有平台和运维成本。小中规模且熟 PG 可 pgvector；大规模独立向量吞吐和 Collection 生命周期用 Milvus；全文/精确词/聚合为主用 OpenSearch。企业常是 SQL + Search + Vector 多路，不必单选。本项目因内网已有 Milvus且需要 Manifest/Profile 独立发布而选 Milvus。

**换场景：只有 10 万 Chunk。**

> 更可能选择 pgvector/PG FTS，减少 etcd/Milvus 运维；业务 Port 和 Manifest 思路仍可保留。

---

## 8. 检索连续追问

### 题组 18：为什么 Hybrid Retrieval？

**回答**：自然语义和同义表达适合 Dense；制度编号、金额、错误码适合 Sparse。并行宽召回，用 Weighted RRF 融合不同量纲排名，再 PG 回源、多样性和 Reranker。

**追问：Dense/Sparse 权重怎么定？**

> 按问题类型分层 Golden 做网格/贝叶斯调参，看 Recall/NDCG/P95。编号问题可提升 Sparse，语义问题偏 Dense；必要时 Query Route 动态选权重。0.65/0.35 是基线不是定理。

**追问：为什么不是分数归一化相加？**

> 不同 Provider 分布和升级漂移难校准，RRF 稳健、可解释；若有大量稳定标注，可升级 normalization/LTR，但要维护标定和漂移监控。

### 题组 19：请手算 RRF。

公式：

```text
score(d) = Σ routeWeight_i / (k + rank_i(d))
```

必须能手算第 9 章示例，并解释 `k` 越大，头部名次差异越平滑；不是把 Dense 相似度和 BM25 原分直接相加。

**追问：候选只在一条路线出现怎么办？**

> 它仍获得该路线贡献；另一条没有贡献。若路线权重和 TopK 设计合理，强单路候选仍能进入后续 Rerank。

### 题组 20：TopK 怎么调？

**回答**：Initial TopK 用 Recall@K 曲线和候选多样性定；Final TopK 用 Reranker/Context Token/答案质量定。TopK 小漏证据，大则噪声、延迟和成本上升。

**追问：Recall@40 高但答案仍差？**

> 查 Reranker 是否排掉、PG 回源是否剔除、Context 是否裁剪、Chunk 上下文是否缺失、答案模型/Validator；不能继续无限加 TopK。

### 题组 21：为什么 Milvus Filter 后还要 PG 回源？

**回答**：Filter 是服务端第一道权限/版本剪枝，但向量 metadata 是发布投影，撤权/下线/清理有时间差。PG 当前事实复核是最终安全边界，也补全可引用内容。

**追问：这会不会慢？**

> 只回源 Initial TopK 的有限 ID，批量查询、索引优化；安全不能因几毫秒省掉。若成为瓶颈，用批量/投影缓存优化，但授权不确定时 fail closed。

### 题组 22：Query Rewrite 有什么风险？

**回答**：可能丢编号/金额、改变意图、受 Prompt Injection、增加延迟。项目先确定性提取 exact literals，LLM 只建议子问题，重建 Plan 时恢复字面量，不能改权限 Filter；失败降级原问题。

**追问：什么时候不 Rewrite？**

> 简短明确、精确 ID、首轮已足够；路由规则决定，避免每个问题都付一次 LLM 成本。

---

## 9. LangGraph 和生成连续追问

### 题组 23：为什么用 LangGraph？

**回答**：因为检索/答案有条件分支、有限重试/修复、节点状态和逐节点观测；图比嵌套 if 清晰。固定线性流程不会为了框架而用图。

**追问：为什么不用开放 Agent？**

> 权限、成本和时延必须有上限。项目检索最多两轮、生成最多一次修复，LLM 不能决定 ACL/Filter/发布；开放 Agent 更适合低风险研究，不适合安全决策。

**追问：LangGraph 自带持久化为什么还用 PG Run/Step？**

> 业务审计、权限、SSE、保留和跨版本查询需要稳定领域表，不能让框架 Checkpoint 成为不可控事实源。Graph 是执行编排器，PG 是业务事实源。

### 题组 24：Reranker 与 LLM Evidence Rerank 为什么都有？

**回答**：专用 Reranker 计算 query-document 相关性，便宜稳定；LLM Evidence Rerank 只在覆盖/冲突复杂时理解证据组合。后者不能扩大白名单，失败可降级，并非每次调用。

**追问：用生成 LLM 直接排序不更简单？**

> 成本、非确定性和批量吞吐更差，职责混杂；专用 Reranker 可独立评测和扩缩容。

### 题组 25：怎样降低幻觉？

**高分回答**不要只说 Prompt。按层讲：

1. Parser/Chunk 保证事实没有先损坏；
2. Hybrid/Rerank 保证标准证据进入 Context；
3. PG 权限/版本复核；
4. Evidence sourceId 白名单；
5. Context Token/多样性；
6. 结构化 Claim/Citation；
7. 确定性金额/日期/计算规则；
8. 可选 Semantic Judge；
9. 冲突/不足拒答；
10. Golden 和生产反馈。

**追问：温度 0 能解决吗？**

> 只能降低随机性，不能补缺失证据、阻止引用编造或保证底层版本确定。

### 题组 26：Citation 怎么保证不是模型编的？

**回答**：服务端 Evidence Builder 先生成 sourceId 白名单；模型只返回这些 ID；Validator 检查存在性、Claim 覆盖、source hash、Manifest 和当前有效权限；详情接口再授权。

**追问：模型引用了真实 sourceId，但内容不支持 Claim？**

> 白名单只证明来源存在，不证明蕴含；确定性规则和 Semantic Judge 检查 Claim 支持，失败修复或拒答。

### 题组 27：为什么严格模式不流式输出正文？

**回答**：Token 一旦到用户端不可收回。Validator 可能后来发现越权、数字错误或无效引用，所以严格场景只流阶段事件，FinalAnswer 校验后发布。

**换场景：低风险客服非常看重首 Token。**

> 可以提供“未验证草稿”流并在最终替换，但要产品明确风险、内容策略和撤回体验；高风险制度仍保持 strict streaming。

### 题组 28：证据不足、冲突怎么处理？

**回答**：Evidence Router 区分回答、部分回答、澄清、LLM 证据重排、拒答。冲突必须在同一子问题/可比事实位置判断，结合版本和 authority；不是文档里出现多个数字就冲突。

**追问：为什么不让 LLM 自己选一个？**

> 有效制度冲突是治理问题，不是语言生成问题。系统应展示来源/版本并转人工或要求澄清，不能静默猜。

---

## 10. 权限、安全和隐私连续追问

### 题组 29：只有 userId/roles，如何做企业权限？

**回答**：认证适配器从企业网关/JWT获取 userId/roles，Role Mapper 转语义角色；Space Grant 决定访问；请求 Space 与当前授权取交集；Filter 编译；PG 回源；Citation 再鉴权。默认拒绝。

**追问：Trusted Header 在内网安全吗？**

> 只有当网关清洗用户同名 Header、重新注入，并隔离后端直连时才安全；可加时间戳/HMAC。内网不等于天然可信。

**追问：如果未来有部门/ABAC？**

> 扩展 Auth Context/Policy Port 和授权版本，Run Snapshot 记录必要摘要；检索 Filter 仍由服务端编译。不能让客户端传 department 后自证权限。

### 题组 30：怎样防 Prompt Injection？

**回答**：文档和用户内容都视为不可信数据；System Rule 与 Evidence 明确分隔；LLM 不能构造 SQL/对象 Key/Milvus Filter或决定权限；工具参数用 Schema/白名单；Citation 和输出校验；测试集包含恶意指令；高风险工具需人工审批。

**追问：在 Prompt 里写“忽略文档指令”够吗？**

> 不够。Prompt 是一层软约束，真正安全依赖权限在模型外、工具最小权限、结构化 Schema、结果校验和审计。

### 题组 31：为什么加密问题正文？

**回答**：普通数据库查询、备份泄漏或运维访问不应直接看到问题。AES-256-GCM 提供机密性和完整性，Key 来自 Secret，配合访问控制和保留策略；日志/Trace 不记录正文。

**追问：加密后怎么搜索和排障？**

> 使用受控解密权限；普通观测保存 Hash、长度、分类、版本和错误码。需要全文审计时走专门审批，不能为了排障让所有日志明文。

---

## 11. 评测、SLO 和生产连续追问

### 题组 32：RAG 怎么评测？

**回答**：分层：Parser/OCR 结构；Chunk 覆盖/重复；Retrieval Recall/MRR/NDCG/权限泄漏；Answer Faithfulness/Citation/拒答；Production P95/P99/错误率/成本/队列年龄。数据集覆盖正常、无答案、冲突、数字、表格、多跳、权限和 Injection。

**追问：为什么只测答案准确率不行？**

> 端到端失败无法定位；同一个答案分数可能掩盖检索退化和模型偶然猜中。分层指标才能决定改 Parser、Chunk、检索还是生成。

**追问：Judge 也是 LLM，可信么？**

> 不能当唯一真相。用人工标注子集校准，一致性/偏差评估，确定性指标优先，多 Judge/抽检，版本固定；Judge 用于规模化辅助。

### 题组 33：如何建立 Golden Dataset？

**回答**：从真实脱敏问题、文档和业务专家标注出标准答案/证据/无答案/权限，覆盖头部和长尾；按文档版本固定；训练/调参/最终验证分集；变更后做回归并审阅新增失败。

**追问：用户点赞能直接当标准答案吗？**

> 不能。反馈有选择偏差、误点和表达偏好，可用于采样候选，需专家/规则清洗；点击也会受排名偏差影响。

### 题组 34：容量怎么估？

**回答**：日文档×页×Chunk 得向量增长和 Embedding 窗口；问答 QPS×各 Provider 调用数/延迟得并发；向量数×维度×4 粗估原始存储；再加索引、副本、重建双份空间。用 k6/Soak 校准。

**追问：为什么平均值不够？**

> 峰值、P95/P99、长文档、重试风暴和全量重建决定容量；平均 QPS 会掩盖突发。

### 题组 35：你会定哪些 SLO？

示例维度而非虚构数字：

- Query 成功/正确拒答可用率；
- P95/P99 Run 延迟，按简单/复杂路由分层；
- 入库从上传完成到可检索的 freshness；
- Outbox/Queue oldest age；
- Retrieval Recall 与权限泄漏率（必须为 0）；
- Citation validity/Faithfulness；
- Provider 降级率和每问 Token/成本。

具体阈值由业务风险和内网压测确定。

### 题组 36：Redis 挂了会怎样？

**回答**：Cache Redis 挂则安全绕过、性能下降；BullMQ Redis 挂则 PG Outbox 保留任务，恢复后续发；Stream 挂则实时事件受影响，可从 PG 状态恢复。告警看 oldest age/发布失败，不能称“完全无影响”。

**追问：两个 Redis 为什么分开？**

> 缓存淘汰/热点不能影响任务可靠性；持久化、内存策略和指标不同。小环境可共用但生产要明示风险。

### 题组 37：Milvus 挂了会怎样？

**回答**：入库 Candidate 构建失败，不切 ACTIVE；查询核心 Dense 失败按策略结合 Sparse 决定降级或拒答，全部核心路线失败阻断。SDK 初始化/异步连接异常也必须被统一错误边界捕获。

**追问：为什么不直接用旧缓存答案？**

> 只有缓存携带且仍匹配 Manifest、授权、Policy、模型版本才可用；授权/版本不确定不能为可用性牺牲安全。

### 题组 38：数据库挂了会怎样？

**回答**：PG 是权限和业务事实源，不能安全查询时应 fail closed；不能仅靠 Milvus 返回内容。Worker 不应继续无事实源推进状态；连接池、重试、熔断和恢复后 Outbox/Lease 接管。

### 题组 39：如何迁移数据库不停机？

**回答**：Expand-Contract：先加兼容列/表和双读写/回填，再切应用，最后删旧结构；Migration checksum/advisory lock；一次性 migrate Job 成功后应用启动。避免每副本无序迁移。

### 题组 40：备份了 PG 就能恢复吗？

**回答**：还要 MinIO 对象、配置/Secret、Milvus 是否从 PG/MinIO 可重建、Redis 哪些可丢；定义 RPO/RTO，做实际 Restore Drill。备份成功日志不等于恢复可用。

---

## 12. 故障排查场景题

### 场景 1：答案质量突然下降，但 LLM 没换

按顺序回答：

1. 查生效 Manifest/文档版本是否改变；
2. Parser/Chunk Profile 是否改变；
3. Embedding/Reranker 服务实际 revision 是否漂移；
4. Dense/Sparse 分路 Recall；
5. PG recheck 移除原因；
6. Reranker 排序和 Context 裁剪；
7. Feature Flag 是否降级；
8. Validator/Judge 版本；
9. 对比 Baseline/Canary Trace。

错误回答：“把 Temperature 调低”或“换更大模型”。

### 场景 2：任务队列越来越长

1. 看 oldest age、arrival/service rate，而不只看数量；
2. 分阶段看 Parser/OCR/Embedding 耗时；
3. Provider 429、重试和 DLQ；
4. Worker 并发、CPU/GPU、PG 连接、Redis latency；
5. stalled/Lease 续租；
6. 是否某坏文件制造重试风暴；
7. 扩 Worker 前确认下游 Provider 容量。

### 场景 3：管理员撤权后用户仍看到旧答案

检查：网关身份、授权版本是否递增、Cache Key 是否包含版本、TTL、Run 当前复核、Citation API 再鉴权、是否允许后端直连。修复后要写撤权并发回归测试，而不只是清缓存。

### 场景 4：Dense 搜到，最终候选却没有

逐层看：RRF 权重/排名 → source recheck removed reason → accumulated merge → diversity 上限 → Reranker → Context Token。不要把所有锅推给 Milvus。

### 场景 5：模型返回答案但用户得到拒答

这是可能的正确行为。查 route、Citation whitelist、当前权限、deterministic issue、semantic grounding、第二次修复。生成成功不等于产品答案可发布。

### 场景 6：换 Embedding 后 Milvus 不报错但效果崩了

可能维度相同但空间/revision/template 不同。查 Run Snapshot、Profile metadata、Collection 隔离、查询端/文档端模板、是否错误复用旧缓存。必须重建并重新 Golden。

---

## 13. 白板系统设计题

### 题 1：设计一个银行内网制度问答

回答顺序：需求/风险 → 数据/权限 → 入库 → 索引版本 → 查询 → Evidence/拒答 → 评测 → SLO/恢复。强调有效期、authority、强 Citation、审计和人工升级。

### 题 2：设计制造设备维修助手

强调扫描 OCR/版面、设备型号/版本、错误码 Sparse、步骤 Dense、图号/页码、多模态可能性、现场网络和安全操作提示。

### 题 3：把本项目扩到 5000 万向量、200 QPS

不要只说“加机器”。需要：

- 向量分片/副本/索引类型压测；
- Query/Provider 独立扩容和连接预算；
- 多级召回/缓存/分域路由；
- Embedding/Reranker/LLM 吞吐；
- PG 读模型/批量回源；
- Observability 与容量模型；
- 重建双份空间和发布窗口；
- 故障域、RPO/RTO。

### 题 4：把本项目缩到个人知识库

删除：复杂 RBAC、独立 Milvus、多个 API 进程、严格 Outbox（视风险）。保留：解析、Chunk、版本、引用、基础评测。可用单进程 + SQLite/PostgreSQL/pgvector。能做减法是架构能力。

---

## 14. “为什么不用 X”题库

### 为什么不 Fine-tune 代替 RAG？

知识频繁更新、需要引用和权限，微调难逐条删除/审计，适合行为/风格而非事实存储。可组合：微调模型遵循企业回答格式，事实仍走 RAG。

### 为什么不把整份文档塞长上下文？

成本/延迟高、注意力稀释、权限和版本难控制、引用困难。小文档低 QPS可作为基线，但企业规模需要检索和证据选择。

### 为什么不用 Elasticsearch 代替 Milvus？

不是不能。若全文/过滤主导且已有平台，OpenSearch 很合适；本项目内网已有 Milvus，向量生命周期需求明显，同时自己实现 Sparse 路。选型基于约束而非产品优劣绝对化。

### 为什么不用 Kafka 代替 BullMQ？

本项目是 Node 中型后台 Job，重试/延迟/并发 Worker 更直接；Kafka 更擅长高吞吐可回放事件流。若企业统一 Kafka 且多消费者需要回放，可替换 Event Adapter，但仍需业务幂等。

### 为什么不用 Agent 自己决定检索？

开放 Agent 难控制权限、成本、循环和可复现。项目用规则确定权限和路线边界，LLM 只做受限建议；低风险探索场景才考虑更开放 Agent。

### 为什么不用向量库保存全部 metadata 和权限？

向量库不是强事务授权事实源，权限频繁变化和索引残留会带来越权窗口。它存发布投影，PG 回源当前事实。

---

## 15. 面试官可能抓住的薄弱点

### 薄弱点 1：你说“上线了”，但真实内网没验收

正确说法：代码功能和离线交付完成；真实生产上线还需内网 Provider Contract、业务 Golden、负载/长稳、Chaos、备份恢复和安全扫描。不要混淆“开发完成”和“生产签字”。

### 薄弱点 2：Fixture 测试能证明模型质量吗？

不能。Fixture 证明编排和契约边界；模型质量必须用真实内网模型和业务 Golden。明确测试层级反而加分。

### 薄弱点 3：你为什么没有 ClamAV？

项目按需求移除 ClamAV，保留 Magic Bytes、压缩比/深度、大小、页/像素/单元格、宏/外链等内容安全预检。它不是完整恶意软件检测；若内网合规要求，应接企业安全网关/扫描 Port，而不是宣称代码扫描等价杀毒。

### 薄弱点 4：只有角色，不是细粒度 ACL 吗？

当前身份输入只有 userId/roles，但业务层通过知识空间 Grant 建立授权。若未来需要文档/字段 ABAC，扩展 Policy/Attribute Port 和授权版本；当前不虚构不存在的组织属性。

---

## 16. 反向提问面试官

当对方给出 RAG 设计题，可以反问：

1. 答错和拒答哪个代价更高？
2. 数据更新和权限变更频率？
3. 精确编号、表格和扫描件比例？
4. 真实 QPS、P95 和峰值？
5. 是否已有 Search/Vector/Queue 平台？
6. 是否要求引用、审计和历史回放？
7. 是否允许公网模型，还是完全离线？
8. 谁提供 Golden 和最终业务验收？

这些问题不是拖延，而是展示你从需求推导架构。

---

## 17. 自我模拟方法

每次随机抽一题，按下面计时：

- 30 秒：结论和场景；
- 90 秒：链路和项目证据；
- 60 秒：失败/安全/测试；
- 30 秒：换场景和演进。

录音后检查是否出现：只堆名词、没有失败窗口、没有项目文件/表/状态、把默认参数说成真理、编造生产数字、无法做减法。用 [13-学习实验与答辩验收](./13-学习实验与答辩验收.md) 的量表打分。
