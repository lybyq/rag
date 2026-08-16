# M00 概念与术语

## Monorepo 不是“大文件夹”

Monorepo 的价值是让多个应用在一次变更中共享契约并通过同一组门禁。pnpm lockfile 固定完整依赖图，Workspace 负责包发现；Nest Monorepo 负责编译四个入口。它不能自动保证架构，真正的依赖方向还要靠 ESLint 和 dependency-cruiser。

## 编译期类型与运行时契约

TypeScript 类型在编译后会消失，外部 JSON 即使写着 `as User` 也不会被验证。Zod Schema 在运行时存在，可以拒绝非法输入，再由 `z.infer` 推导 TypeScript 类型。这里坚持“Schema 一份真相源”，并从它生成 OpenAPI/JSON Schema。

## DI 与 Composition Root

依赖注入不是为了少写 `new`，而是让应用用例依赖抽象契约。具体 PG、Milvus 或 DeepSeek Adapter 只能在 App 根模块装配。Domain 不依赖 Prisma/Milvus，才能在无数据库单测中执行，并在内外网切换实现。

## Liveness、Readiness、Metrics、Trace

- Liveness：事件循环还能响应，不访问外部依赖，失败才应该重启。
- Readiness：所有关键依赖能否处理请求，失败时从负载均衡摘除但不盲目重启。
- Metrics：聚合趋势，例如 P95 和错误率，不放高基数 ID。
- Trace：把一次跨服务调用串起来；Request ID 用于日志和用户报障，Trace ID 用于分布式调用树。

## ADR

ADR 记录上下文、选择、替代和后果。它不是永远正确的规范，而是让未来的人知道当时为什么这样做，以及何时需要重新评估。
