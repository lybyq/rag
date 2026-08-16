# Enterprise RAG Knowledge Base

这是一个面向单一企业内网的生产级 RAG 知识库项目。系统将覆盖文档上传、安全解析、OCR、结构化 Chunk、质量审核、Dense/Sparse 混合检索、证据构建、答案校验、引用、评测和生产运维。

当前已完成 M00 工程基线、M01 身份/角色/知识空间，以及 M02 文档接入与任务中心。系统已具备浏览器直传、Multipart 重试、文档/版本/任务事实、事务 Outbox、BullMQ 幂等消费、SSE/ETag 事件恢复、lease/heartbeat 和 Vue 上传任务工作台。

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

完整步骤和镜像拉取故障见本地开发 Runbook。后续实现继续严格按需求编号推进。
