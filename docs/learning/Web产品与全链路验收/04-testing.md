# Web 产品与全链路验收：测试策略

- 组件测试：AI Adapter 契约、响应式主题、解析摘要、质量报告、身份错误和空间表格权限。
- 类型门禁：`vue-tsc -b` 确保模板、Composable 和 Zod 类型共同收敛。
- Playwright：浏览器直传到 PUBLISH 成功、审核双栏、检索调试、SSE 断线轮询恢复、引用二次鉴权和取消。
- API 契约：前端只使用生成 OpenAPI 对应的稳定路径，响应再经运行时 Schema 校验。
- 可访问性：交互控件使用 button/link/label，状态不能只依赖颜色，键盘能完成主流程。

E2E 网络响应是满足公共 Schema 的合成事实，用于验证浏览器状态机；真实 PG/Redis/Milvus/模型链由后端 integration 和最后的 HTTP LangGraph 演示验证。
