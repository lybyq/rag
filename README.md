# Enterprise RAG Knowledge Base

这是一个面向单一企业内网的生产级 RAG 知识库项目。系统将覆盖文档上传、安全解析、OCR、结构化 Chunk、质量审核、Dense/Sparse 混合检索、证据构建、答案校验、引用、评测和生产运维。

当前已完成 M00～M06：工程基线、身份授权、文档接入、文件解析/OCR、知识加工与审核、向量索引与发布，以及会话/Run/顺序事件底座。问答请求已具备并发幂等、冻结执行快照、PG 事实 + Redis Stream、SSE/Ticket 续传、取消、Deadline、AES-GCM 正文保护和历史重新鉴权；真实检索与生成将在 M07/M08 接入，当前不会用假模型结果冒充完成。

## 从这里开始

- [需求基线](./docs/requirements/README.md)
- [总体 PRD](./docs/requirements/00_PRD.md)
- [M00～M10 模块需求主清单](./docs/requirements/01_MODULE_REQUIREMENTS.md)
- [内外网 Provider 配置](./docs/requirements/02_PROVIDER_CONFIGURATION.md)
- [教学型代码与学习标准](./docs/requirements/03_LEARNING_AND_CODE_STANDARD.md)
- [M00 本地启动与故障排查](./docs/runbooks/local-development.md)
- [M00 七份学习资料](./docs/learning/M00-工程与决策基线/01-concepts.md)
- [M01 七份学习资料](./docs/learning/M01-身份角色与知识空间/01-concepts.md)
- [M02 七份学习资料](./docs/learning/M02-文档接入与任务中心/01-concepts.md)
- [M03 七份学习资料](./docs/learning/M03-文件安全解析与OCR/01-concepts.md)
- [M04 七份学习资料](./docs/learning/M04-知识加工质量与审核/01-concepts.md)
- [M05 七份学习资料](./docs/learning/M05-向量化索引与发布/01-concepts.md)
- [M06 七份学习资料](./docs/learning/M06-会话运行与事件底座/01-concepts.md)
- [M06 Run/SSE 运维手册](./docs/runbooks/m06-run-events-and-sse.md)
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
