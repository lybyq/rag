# Web 产品与全链路验收：核心原理

管理端不是数据库表单集合，而是企业知识从上传、处理、审核、发布到问答和运维的“事实窗口”。页面只展示后端确认的状态；上传网络进度来自 XHR 字节事件，处理进度来自 Job SSE/轮询，不能用定时器模拟。

Vue 页面采用 Route View、Feature Composable、API Adapter、展示组件四层。View 只组合，Composable 管状态与副作用，API Adapter 统一身份、错误与 Zod 响应校验，组件只消费明确 props。Element Plus X 只能经 `components/ai-adapter` 暴露，升级不会把第三方 API 散落到业务代码。

安全上，浏览器只有短期企业身份；模型、对象存储长期密钥、Milvus 和内部 Provider 地址都停留在服务端。引用点击时重新鉴权，避免用户打开旧会话后继续读取已经撤权的原文。
