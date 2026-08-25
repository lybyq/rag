# 企业级 RAG 完整学习手册

这套手册不是“看完几个名词就算学会”，而是把本仓库当成一套可运行教材。学完后的目标是：你能从用户上传一个文件讲到答案引用；能解释每个存储和中间件为什么存在；能根据业务规模、安全要求、文档形态和质量目标做选型；出现故障时知道先查哪一层；面试官追问时能拿真实实现、失败案例和取舍回答。

## 1. 学完应该具备什么能力

你至少要能独立完成下面六件事：

1. 画出入库链路和问答链路，讲清楚每一步的输入、输出、状态和失败处理。
2. 用大白话解释 PostgreSQL、Redis Cache、Redis BullMQ、MinIO、Milvus 分别保存什么，为什么不能互相替代。
3. 看懂 API Contract、Event Contract、Provider Contract、Port 和 Adapter，并能接一个新的内网模型服务。
4. 解释 Chunk、Embedding、Dense/Sparse、RRF、Reranker、Evidence、Citation、Validator 和 LangGraph 的作用及选型条件。
5. 根据 Trace、Run Step、Job Step、Outbox、队列状态和 Manifest 定位“卡住、漏数据、答非所问、引用错误”。
6. 完成一次无网络部署，知道哪些问题只改环境变量，哪些问题必须写新 Adapter 或重建索引。

## 2. 先记住整套系统的一句话

> 企业级 RAG 不是“把文档塞进向量库，再问大模型”，而是一个有权限、版本、证据、审计、失败恢复和质量评测的知识生产系统。

普通 Demo 只关心“能不能回答”。企业系统还必须回答：

- 这份文件是谁上传的，现在是否仍有效？
- 当前用户有权看这条证据吗？
- 用的是哪一版解析器、Embedding、Prompt 和索引？
- 队列重复投递会不会生成两份数据？
- 模型服务超时后应该重试、降级还是拒答？
- 答案中的每个关键结论能不能回到原文？
- 换模型、删文件、撤权限后，旧答案和旧索引怎么处理？

本项目的复杂度主要是在回答这些问题，而不是为了“堆技术”。

## 3. 推荐阅读顺序

| 阶段             | 学习材料                                                | 学完后的产出                            |
| ---------------- | ------------------------------------------------------- | --------------------------------------- |
| 第一遍：建立地图 | [01-完整闭环](./01-完整闭环.md)                         | 不看代码画出两条主链路                  |
| 第二遍：理解边界 | [02-契约与分层](./02-契约与分层.md)                     | 能解释 Contract、Port、Adapter          |
| 第三遍：理解底座 | [03-数据与异步基础设施](./03-数据与异步基础设施.md)     | 能排查 PG、Redis、BullMQ、MinIO、Milvus |
| 第四遍：理解算法 | [04-RAG算法与选型](./04-RAG算法与选型.md)               | 能根据场景选择检索、分块和生成策略      |
| 第五遍：生产治理 | [05-可靠性安全评测与排障](./05-可靠性安全评测与排障.md) | 能解释上线门禁和常见故障                |
| 第六遍：动手练习 | [06-学习计划与实验](./06-学习计划与实验.md)             | 独立跑通、改坏、定位、修复              |
| 第七遍：面试表达 | [07-企业级RAG面试深挖](./07-企业级RAG面试深挖.md)       | 能回答方案题和连续追问                  |
| 最后：内网交付   | [08-内网离线部署](./08-内网离线部署.md)                 | 能完成配置、导入、启动和验收            |

## 4. 项目源码地图

```text
apps/
  platform-api             管理面：空间、权限、上传、任务、评测、运维
  rag-query-service        查询面：会话、Run、检索、答案、SSE
  ingestion-worker         入库数据面：解析、加工、向量化、索引
  scheduler-worker         后台调度：Outbox、维护、评测、超时恢复
  document-parser-service  隔离的多格式 Node Parser
  web-console              Vue 管理端和 AI 问答端

libs/
  contracts                跨进程数据形状和 Zod 运行时校验
  domain                   不依赖框架的业务不变量
  application              Use Case、Port、事务编排、状态推进
  rag-graph                LangGraph 查询与答案工作流
  retrieval                RRF、Filter、字面量、多样性等纯算法
  evidence                 证据包、上下文预算、引用和校验算法
  persistence-*            PostgreSQL、Redis、MinIO、Milvus Adapter
  model-gateway            LLM、Embedding、Reranker Adapter
  file-processing-*        Parser、OCR、安全预检 Adapter

database/migrations        可前滚、带 checksum 的数据库演进
docs/requirements          需求真相
docs/learning              分模块教材和本总手册
docs/runbooks              上线后的操作手册
deploy                     Docker、离线部署与故障演练
evaluation                 Golden 数据集和质量门禁
performance                k6 性能测试
```

## 5. 本项目最值得讲的亮点

### 5.1 PostgreSQL 是事实，队列和缓存不是事实

任务先在 PG 事务里落 Job、Step、Event 和 Outbox，再异步投递 BullMQ。Redis 丢失后可以从 PG 恢复；如果反过来先发队列再写数据库，就会出现“Worker 收到任务但业务记录不存在”的幽灵任务。

### 5.2 用 Port/Adapter 隔离内外网供应商

业务代码只知道 `EmbeddingPort`、`RerankerPort`、`OcrPort`，不知道 BGE、PaddleOCR、DeepSeek 或某个 SDK。协议一致时只改 env；协议不同只新增 Adapter，不改领域和工作流。

### 5.3 每次 Run 冻结可复现快照

问答开始时锁定用户、角色、空间、Manifest、Embedding Profile、Prompt、Policy 和流程版本。这样模型升级后，历史答案仍能解释“当时为什么这样答”。

### 5.4 Milvus 召回后再回 PostgreSQL 复核

Milvus Filter 是第一道候选过滤，不是最终授权。候选必须回 PG 校验空间、文档版本、发布状态和 ACL，防止撤权延迟、索引残留或恶意 Filter 导致越权。

### 5.5 索引先构建、对账，再原子发布

新向量写入候选 Collection，数量、主键、Hash、Profile 和固定查询全部通过后，才切换 Manifest Head/Alias。失败不会污染正在服务的旧索引，回滚也不需要删改在线数据。

### 5.6 答案不是模型一锤子买卖

检索结果先变成 Evidence Bundle，经过冲突/不足/敏感路由、上下文预算、结构化生成、引用重校验、规则校验和可选语义 Judge，最后才成为答案。证据不够时拒答是正确产品行为。

### 5.7 真实进度而不是前端动画

前端进度来自 PG Job Step/Event，经 SSE 或 ETag Poll 返回。刷新、断线、Worker 重启后都能恢复，不用定时器伪造“99%”。

### 5.8 失败被设计成正常状态

远程调用有 Deadline、单次超时、AbortSignal、有限重试、错误分类、熔断和降级。任务有 Lease、Heartbeat、幂等键和 Inbox Receipt。企业系统不是假设不失败，而是假设一定会失败并让失败可恢复。

## 6. 判断自己是否真的学会

不要用“代码看过一遍”判断。用下面的闭卷标准：

- 10 分钟画出入库和查询时序图。
- 5 分钟解释为什么有两个 Redis。
- 手算一个 Dense/Sparse 排名的 Weighted RRF。
- 解释 BullMQ 重投三次为什么不会多建三个文档。
- 解释用户权限撤销后为什么不能只等 Milvus 更新。
- 给出更换 Embedding 维度的安全发布步骤。
- 从一个 `runId` 找到 Run Step、检索候选、证据、引用和校验报告。
- 从一个 `jobId` 找到 Outbox、BullMQ、Inbox、Lease、Step 和失败分类。
- 面对“为什么不用一个 Nest 应用、一个 Redis、一个数据库表”能讲出资源隔离和故障域取舍。
- 面对新内网 Provider，能先做契约对比，再决定改 env 还是写 Adapter。

都能做到，才算真正掌握这套项目。
