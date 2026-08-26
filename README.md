# Enterprise RAG Knowledge Base

这是一个面向单一企业内网的生产级 RAG 知识库项目。系统将覆盖文档上传、安全解析、OCR、结构化 Chunk、质量审核、Dense/Sparse 混合检索、证据构建、答案校验、引用、评测和生产运维。

当前已完成工程基线、身份授权、文档接入、文件解析/OCR、知识加工与审核、向量索引与发布、会话/Run/顺序事件、查询规划与混合检索、证据生成与答案校验、评测与生产可靠性、Web 产品和全链路验收。真实 PostgreSQL、Redis、MinIO、Milvus 的合成文档入库和 LangGraph 问答已经走通；外网未配置真实模型密钥时使用明确标记的 Fixture，只验证编排与契约，不把 Fixture 文案冒充模型效果验收。正式内网仍须完成 Provider Golden、长稳、Chaos、容量及业务 RPO/RTO。

## 从这里开始

- [需求基线](./docs/requirements/README.md)
- [总体 PRD](./docs/requirements/00_PRD.md)
- [工程与决策基线～前端体验 模块需求主清单](./docs/requirements/01_MODULE_REQUIREMENTS.md)
- [内外网 Provider 配置](./docs/requirements/02_PROVIDER_CONFIGURATION.md)
- [教学型代码与学习标准](./docs/requirements/03_LEARNING_AND_CODE_STANDARD.md)
- [企业级 RAG 完整学习手册](./docs/learning/企业级RAG完整学习手册/README.md)
- [从零到企业级 RAG 逐课精讲](./docs/learning/企业级RAG完整学习手册/09-从零到企业级RAG逐课精讲.md)
- [企业级 RAG 面试连续深挖](./docs/learning/企业级RAG完整学习手册/12-企业级RAG面试连续深挖.md)
- [学习实验与答辩验收](./docs/learning/企业级RAG完整学习手册/13-学习实验与答辩验收.md)
- [内网 Provider HTTP 契约](./docs/contracts/provider-http-contracts.md)
- [无网络 Docker Compose 部署模板](./deploy/airgap/README.md)
- [工程与决策基线 本地启动与故障排查](./docs/runbooks/local-development.md)
- [工程与决策基线 七份学习资料](./docs/learning/工程与决策基线/01-concepts.md)
- [身份、角色与知识空间 七份学习资料](./docs/learning/身份角色与知识空间/01-concepts.md)
- [文档接入与任务中心 七份学习资料](./docs/learning/文档接入与任务中心/01-concepts.md)
- [文件安全解析与 OCR 七份学习资料](./docs/learning/文件安全解析与OCR/01-concepts.md)
- [知识加工、质量与审核 七份学习资料](./docs/learning/知识加工质量与审核/01-concepts.md)
- [向量化、索引与发布 七份学习资料](./docs/learning/向量化索引与发布/01-concepts.md)
- [会话、Run 与事件底座 七份学习资料](./docs/learning/会话运行与事件底座/01-concepts.md)
- [查询规划与混合检索 七份学习资料](./docs/learning/查询规划与混合检索/01-concepts.md)
- [证据生成与答案校验学习资料](./docs/learning/证据生成与答案校验/01-concepts.md)
- [评测与生产可靠性学习资料](./docs/learning/评测与生产可靠性/01-concepts.md)
- [Web 产品与全链路验收学习资料](./docs/learning/Web产品与全链路验收/01-concepts.md)
- [会话运行与事件 Run/SSE 运维手册](./docs/runbooks/conversation-run-events-and-sse.md)
- [架构决策 ADR](./docs/adr/README.md)

## 快速验证

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm dev:infra
pnpm db:migrate
pnpm health:deep
pnpm seed:dev
pnpm dev:services
```

完整步骤和镜像拉取故障见本地开发 Runbook。迁入内网前还必须完成各模块验收文件中明确保留的企业 Provider、集群故障和容量复验项。
