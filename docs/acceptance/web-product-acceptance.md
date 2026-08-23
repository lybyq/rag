# Web 产品与全链路验收记录

验收日期：2026-08-23

## 需求映射

| 范围         | 主要实现与证据                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| WEB-001～004 | Vue 3/TS/Vite/Router/Pinia；Element Plus Token；`components/ai-adapter` 封装 Element Plus X 2.0.3，版本测试固定精确值 |
| WEB-005～008 | 开发身份切换、生产隐藏；平台总览；空间搜索/权限操作；治理抽屉含基本信息、授权、质量策略、Manifest/Profile 和策略历史  |
| WEB-009～015 | 文档筛选/排序/游标/批量重处理；真实 XHR 字节/速度/ETA；Job SSE/轮询与完整步骤；文档详情多标签页                       |
| WEB-016～017 | 审核台 Parse/Block/OCR 与 Quality/Chunk 双栏；检索测试展示 Plan、Dense/Sparse、RRF、Rerank 和移除摘要                 |
| WEB-018～022 | 会话、空间/模式、公开节点状态、取消；Markdown/代码/表格/Claim 引用/反馈；引用打开二次鉴权；五类答案终态               |
| WEB-023～026 | 评测中心、Provider/Profile 非敏感健康、任务告警与受权动作、审计筛选和脱敏 CSV 导出                                    |
| WEB-027～030 | loading/empty/error/retry/forbidden/cancelled；Playwright 关键链路；企业知识工作台视觉；浏览器不持有长期外部密钥      |

## 浏览器验收

`pnpm test:e2e` 覆盖五条浏览器测试：

1. 文件直传后由服务端返回真实 Job，并观察到 `PUBLISH/SUCCEEDED`。
2. 审核台打开原文/Block 与质量/Chunk 双栏及可行动空态。
3. 检索测试展示 Dense/Sparse、RRF、Rerank 和权限版本剔除摘要。
4. SSE 连续断线后轮询恢复答案，引用点击时重新鉴权。
5. 用户取消 Run 后显示独立、安全的取消状态。

组件测试固定 AI Adapter 契约并覆盖基础页面组件；`vue-tsc` 覆盖模板与 Composable 类型。浏览器响应使用满足公共 Zod Schema 的合成数据，真实依赖由后端集成测试和真实 HTTP LangGraph 演示补足。

## 安全结论

- Web 仅调用 platform/query API；没有 Milvus、模型或 MinIO 长期密钥。
- 候选正文不从 retrieval-debug 返回；只有 citation preview 逐次鉴权后返回最小摘录。
- 公开阶段不包含系统 Prompt、隐藏候选或模型私有思维链。
- 审计 CSV 在服务端生成、限制条数、脱敏并防公式注入。
