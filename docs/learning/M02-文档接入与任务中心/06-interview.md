# M02 面试追问：如何经得住企业落地拷打

## 1. 为什么不让文件经过 NestJS API？

答：API 只做控制面。大文件经过 API 会产生双倍流量、长连接和临时存储压力，也让扩容单位被上传吞吐绑架。服务端鉴权后签发绑定随机 Key 和短 TTL 的 URL，浏览器直达 MinIO。完成时 API 通过 HEAD 验证对象事实，所以不是“信任前端说上传成功”。

追问：那权限怎么保证？

答：签名前检查空间 WRITE；Key 由服务端 UUID 生成；URL 绑定 method/key/expiry；完成接口再次鉴权；对象在隔离 bucket，M03 安全门禁前不会发布检索。

## 2. MinIO 成功、PG 失败怎么办？

答：这是无法用本地事务消除的跨系统窗口。对象 Key 稳定，重试 Complete 时先 HEAD。如果对象已存在且 size/MIME/可用 Hash 匹配，就跳过重复 Multipart complete，只重试 PG 事务。长期没有业务引用的对象由生命周期/对账清理。

## 3. PG 成功、Redis 失败怎么办？

答：消息不是在 API 事务后直接发，而是与业务事实一起写 Outbox。Scheduler 稍后 `SKIP LOCKED` 领取；失败清除 lease 并延迟重试。PG 成功一定留下可恢复的待发布事实。

## 4. 你实现了 exactly once 吗？

答：没有宣称网络 exactly once。采用 at-least-once：Outbox 可能重复投递，BullMQ 用 eventId 去重，Consumer 还用 Inbox 主键去重，并把收据与状态副作用放在同一 PG 事务。最终业务效果幂等。

## 5. 为什么同时需要业务幂等和数据库唯一约束？

答：应用层可以快速返回已有结果，减少锁和写入；但并发请求可能同时通过应用检查，所以数据库的行锁和唯一约束是最终防线。只靠其中一层都有竞态或糟糕的错误体验。

## 6. versionNumber、contentRevision、pipelineVersion、stepVersion 分别是什么？

- versionNumber：用户上传了业务新版本。
- contentRevision：相同原文件重新生成派生内容。
- pipelineVersion：整条流程定义版本。
- stepVersion：单个处理器协议/实现版本。

稳定 Job/Step ID 包含这些维度，既能重现历史，又不会错误复用不兼容产物。

## 7. 任务进度怎么算？

答：每一步上报真实 processed/total，服务端计算 stagePercent，再按版本化权重算 overall。total 未知时 stagePercent=null，前端显示 indeterminate。绝不按时间每秒自增，因为 OCR、解析和 Embedding 的耗时分布完全不同。

## 8. Worker 崩溃怎么恢复？

答：领取时写 leaseOwner/leaseExpiresAt，处理时 heartbeat 续租。只有当前 owner 且 lease 未过期能更新。Scheduler 通过行锁领取过期任务，有限次数重排队，超过次数 WAITING 人工处理，避免有毒文档无限重试。

追问：旧 Worker 又恢复了呢？

答：它的 owner 或 lease 已失效，heartbeat 更新返回 undefined，不能覆盖新 Worker。

## 9. 为什么事件放 PG，不直接放 Redis Stream？

答：M02 事件量相对低，首要目标是与任务状态同事实源、可查询和可审计。PG bigserial 能支持 Last-Event-ID。M06 的高频生成流会使用 Redis Stream，但最终结果仍先持久化。

## 10. SSE 断了怎么办？

答：SSE 根据 Last-Event-ID 从 PG 补发。企业代理禁用长连接时，前端使用 `after` 游标和 If-None-Match，304 不重复传输。事件是通知，页面也会重新查询 Job 快照，所以不会靠事件重建唯一真相。

## 11. 你如何证明 200 MiB 不经过 API？

答：创建会话契约只有文件描述，没有 Buffer/stream 字段；Controller 不注册 multipart body parser；前端 XHR 的目的地址是预签名 MinIO URL；单元测试用 `sizeBytes=200 MiB` 只验证元数据被规划为 25 个分片。真实环境再用网关流量和 API RSS 指标验收。

## 12. 这套方案还有哪些未完成风险？

答：M02 只建立接入与任务底座。魔数/MIME 交叉验证、恶意软件扫描、可信流式 SHA-256、压缩炸弹和隔离 Parser 属于 M03；质量门禁属于 M04；向量发布一致性属于 M05。不能因为上传成功就让内容进入检索。
