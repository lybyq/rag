# M00 面试追问与参考答案

## 1. 为什么 Domain 不能依赖 Prisma？

Domain 表达业务不变量，Prisma 是持久化实现。直接依赖会让领域测试需要数据库、Schema 变化穿透业务规则，也无法换实现。本项目通过依赖门禁强制 Domain 只依赖 contracts/domain，Repository 端口在内、Prisma Adapter 在外；用 unit 与 dependency graph 同时证明。

## 2. TypeScript 和 Zod 分别解决什么？

TypeScript 只在编译期约束受控代码，运行时 JSON 不会自动安全。Zod 对进程配置、HTTP 和事件执行真实校验，再推导 TS 类型并生成 OpenAPI。只写 interface 会把不可信输入伪装成类型正确。

## 3. 为什么既要 Request ID 又要 Trace ID？

Request ID 易于从响应交给用户并检索日志；Trace ID 由分布式追踪系统定义，串联跨服务 Span。没有 OTel 时仍需 Request ID。系统校验上游 ID 格式，并在响应头、Envelope、日志中传播。

## 4. Liveness 为什么不能检查数据库？

数据库抖动时所有实例会同时失败并被重启，造成重启风暴且不修复数据库。Liveness 只证明进程活着；Readiness 访问关键依赖，把不完整实例从流量池摘除。两类端点通过故障注入测试区别。

## 5. 为什么是四个进程，不是一个或十几个？

中型规模下管理、在线问答、文档处理、调度有明确资源/SLO差异，四个部署单元足以隔离和独立扩缩容。更细微服务会增加网络、一致性和运维成本。监控资源竞争或团队边界变化后再拆。

## 6. DI 的价值只是方便 Mock 吗？

Mock 只是结果。核心价值是依赖反转：用例声明需要什么能力，Composition Root 决定外网 DeepSeek 还是内网 LLM、Milvus 还是测试替身。这样权限、超时和错误语义能在端口统一，并用契约测试防实现漂移。

## 7. 日志脱敏为什么不能靠开发者记住？

异常对象和请求头很容易自动携带 token/cookie。人工约定会遗漏，本项目在 Pino 根配置集中 redact，再让异常 Filter 只返回稳定通用消息。还需在测试中加入 canary secret，确认日志和响应均不出现；生产密钥仍应由密钥系统管理。

## 8. Prometheus 标签为什么不能放 userId？

每个不同标签组合都是时间序列，userId/documentId 会制造高基数，导致内存和查询成本爆炸。指标只放 method、route template、status 等有限集合；个体定位使用日志和 Trace。

## 9. 为什么 Worker 也需要 HTTP 端口？

不是给业务调用，而是让编排系统读取 liveness/readiness 和 Prometheus 指标。消费者卡死、队列断开时可被发现。业务流量与探针必须在网络策略上区分，后续 Worker 的 readiness 还会包含队列消费能力。

## 10. lockfile、固定版本和 SBOM 各自作用？

固定直接版本减少无意升级，lockfile 固定完整传递依赖图，镜像 release tag/digest 固定系统依赖，SBOM 列出最终物料供漏洞响应。它们不替代安全扫描；CI 仍运行 audit/Trivy，并在升级时重新验证契约和回归。

## 11. OpenAPI 为什么从 Zod 生成而不是手写？

手写文档最常见失败是实现变了、文档没变。Zod 同时用于运行校验和 JSON Schema 生成，CI 重建后执行 diff，任何契约变化都必须显式评审。对于兼容性还需后续加入破坏性 diff 工具。

## 12. 当前方案到更大规模怎样演进？

先以指标定位瓶颈：在线查询按并发扩容，Worker 按队列积压扩容；PG 增加只读副本和分区；Milvus 按 collection/shard 规划；事件改为独立消息平台。边界端口保持不变，避免容量升级等同业务重写。
