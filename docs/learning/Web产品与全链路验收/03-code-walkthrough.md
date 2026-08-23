# Web 产品与全链路验收：代码执行顺序详解

## 1. 应用启动与身份

1. `router/index.ts` 定义语义路由，`AppShell.vue` 组合主导航和用户状态。
2. `platformApi.ts` 在开发环境附带所选 mock preset；生产构建不显示 Mock 登录入口。
3. 每个响应先解析统一 Envelope，再用具体 Zod Schema 校验，错误进入稳定页面状态。

## 2. 文档上传与真实进度

1. `useDocumentUpload` 校验文件并调用 `/uploads` 申请单文件或分片 URL。
2. XHR `progress.loaded/total` 更新实际字节；相邻样本计算速度，再用 EMA 降低抖动。
3. ETA 只由剩余字节/实际速度计算；没有样本时显示未知，不伪造倒计时。
4. 分片失败只重传失败 part，累计进度保持单调；用户取消会中止当前 XHR。
5. 对象上传完成后调用 complete，只有服务端返回 Job 才显示“进入后端任务队列”。
6. `useIngestionJobs` 读取真实步骤、百分比、耗时、Trace 和安全错误；SSE 断线后带游标轮询。

## 3. 审核与检索调试

1. 审核台用 documentVersionId 并行加载 Parse Run 和 Knowledge Run。
2. 左栏展示页码/Block/OCR，右栏展示 Chunk、问题和审核动作；空态说明下一步而不是空白。
3. Retrieval Lab 输入本人可见 Run ID，服务端再次鉴权后返回 Query Plan、双路、RRF、Rerank 与移除摘要。

## 4. LangGraph 问答

1. `useRagChat` 创建/选择会话并提交带幂等键的 Run。
2. SSE 按 sequence 合并公开事件；连续失败后轮询 Run 和 Messages，刷新也能恢复。
3. `AiThinking` 展示公开节点状态，取消按钮调用服务端取消而非只停止动画。
4. `AiMessageList` 按 ANSWERED、PARTIAL、CLARIFICATION、CONFLICT、REJECTED 显示一致但可辨识状态。
5. 点击 Claim 引用才调用 citation preview；服务端撤权会得到 forbidden，而不是复用旧正文。
6. 反馈关联 messageId，错误类型使用稳定枚举，便于评测下钻。

## 5. 运维控制面

评测、Provider、队列、告警、Feature Flag 和审计都通过 `useOperationsConsole` 访问受权 API。密钥只显示 `configured`，CSV 导出在服务端脱敏并防公式注入。
