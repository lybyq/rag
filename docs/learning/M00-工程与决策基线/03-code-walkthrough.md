# M00 代码逐步讲解

本章按进程真实执行顺序解释关键语句。简单 import 和括号不重复翻译，重点讲每行产生的状态和保护作用。

## 1. 入口与配置

文件：`apps/platform-api/src/main.ts`

| 语句                                   | 解释                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `import '@rag/observability/register'` | 必须最先执行。HTTP 模块先加载再注册 OTel，会漏掉自动埋点。                                                               |
| `bootstrapHttpApplication(...)`        | 四个进程复用同一启动策略，差别只有业务根模块和端口类别。`void` 明确入口不等待 Promise，但错误由进程级日志/退出策略处理。 |

文件：`libs/config/src/app-config.ts`

| 代码区段                                      | 解释                                                           |
| --------------------------------------------- | -------------------------------------------------------------- |
| `AppEnvironmentSchema.safeParse(environment)` | `process.env` 全是不可信字符串；先校验再进入业务。             |
| `superRefine`                                 | 只在 production 增加跨字段安全约束，避免本地默认口令误带上线。 |
| `AppConfigError(issues)`                      | 只保存字段路径和原因，不保存原始密钥值。                       |
| `Object.freeze`                               | 防止运行时某模块修改全局配置，产生同进程行为不一致。           |

删除生产校验后，本地默认数据库密码可以随镜像进入生产；直接散落读取 `process.env` 则无法一次性证明配置完整。

## 2. 请求上下文

文件：`libs/observability/src/request-context.ts`

| 代码区段                                   | 解释                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `safeRequestIdPattern`                     | 上游 ID 只能包含日志安全字符，阻止换行等日志注入。                                           |
| `trace.getActiveSpan()`                    | HTTP 自动埋点已经建立 Span 时，提取其 Trace ID。关闭 OTel 时该值为空，但 Request ID 仍可用。 |
| `response.setHeader`                       | 用户拿到报障 ID，服务之间也能继续传播。                                                      |
| `requestContextStorage.run(context, next)` | `next` 必须在 `run` 内调用，后续 await 链才能读取同一上下文。                                |

若把上下文放在全局变量，并发请求会互相覆盖 ID；若无格式白名单，客户端可把恶意换行写入日志。

## 3. Readiness 聚合

文件：`libs/health/src/health.service.ts`

| 代码区段                 | 解释                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `probes = [...]`         | 聚合器只按 `HealthProbe` 契约调用，但 Nest 注入具体 Adapter；后续可按服务调整必需依赖。 |
| `Promise.all`            | 五个探针并发执行，总耗时接近最慢项而不是五项之和。                                      |
| `Promise.race`           | 每个探针有业务层总超时，即使某 SDK 自己的超时失效，也不会永久挂起 readiness。           |
| `every(status === 'up')` | 当前关键依赖采用全有或全无的就绪策略，不把不完整实例放入流量池。                        |

Liveness 故意不调用探针。否则一次 Redis 抖动会触发所有 Pod 重启，进一步放大故障。

## 4. 异常与日志

文件：`libs/observability/src/api-exception.filter.ts`

`mapStatus` 把易变的框架/SDK 错误压缩为稳定客户端语义。`retryable` 由服务端判断，客户端不能看到 500 就盲目重试。`logger.error({ err })` 保留内部堆栈，但 Pino 在模块层对 authorization、cookie、password、secret、token 做递归脱敏。响应只包含通用 message。

## 5. 前端健康状态

文件：`apps/web-console/src/features/operations/composables/useServiceHealth.ts`

`serviceDefinitions` 是四进程只读目录。每次请求创建独立 `AbortController`，2.5 秒后主动中断；JSON 通过共享 `ServiceHealthEnvelopeSchema.parse`，因此后端契约漂移会立刻成为可测错误。`shallowRef` 适合“整数组替换”策略，避免不需要的深层代理。

## 6. 测试如何证明

- `app-config.spec.ts`：开发默认可加载、生产默认被拒绝、错误不泄密。
- `api-envelope.spec.ts`：运行时 Schema 接受正确 Envelope 并拒绝错误结构。
- `health.service.spec.ts`：证明 liveness 不访问依赖，且一个依赖 down 足以让 readiness down。
- `PageHeader.spec.ts`：证明 Vue 组件按 props 展示，不把页面文案硬编码到公共组件。
