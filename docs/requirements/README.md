# 企业级 RAG 需求基线

本目录是后续模块化实现、测试和验收的需求真相。原始工程蓝图为 `D:\Download\RAG_总方案_02_代码架构与工程实施蓝图.md`，若两者存在差异，以本目录中针对当前项目确认过的约束和最新 ADR 为准。

## 文档导航

| 文档                                                                   | 用途                                         |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| [00_PRD.md](./00_PRD.md)                                               | 产品目标、用户、范围、指标、总体架构与路线   |
| [01_MODULE_REQUIREMENTS.md](./01_MODULE_REQUIREMENTS.md)               | 全部语义模块的编号化需求、代码映射和验收门禁 |
| [02_PROVIDER_CONFIGURATION.md](./02_PROVIDER_CONFIGURATION.md)         | 外网开发、内网切换、认证与模型能力配置基线   |
| [03_LEARNING_AND_CODE_STANDARD.md](./03_LEARNING_AND_CODE_STANDARD.md) | 中文 JSDoc、代码讲解、学习路线和面试训练要求 |
| [llm-wiki-implementation-plan.md](./llm-wiki-implementation-plan.md)   | 第一阶段 Wiki：第三方编译内核与企业集成计划  |
| [agentic-rag-auto-implementation-plan.md](./agentic-rag-auto-implementation-plan.md) | 当前优先：单开关受控 Agentic RAG Auto 完整实施计划，尚未实施 |

## 已确认约束

本轮已批准并实施：[内网 RAG 优化计划](./intranet-rag-optimization-plan.md)，覆盖正确性、性能、内网模型适配、真实处理时间线与外部业务接入。当前代码进度、验证结果和仍需内网实测的门禁见 [优化实施证据](../acceptance/intranet-rag-optimization-evidence.md)；未勾选项不代表已交付。

1. 系统部署在单一企业内网，不建设多租户体系。
2. 登录上下文只有 `userId` 和 `roles`；接入方式暂不确定，必须支持可配置适配。
3. 外网先完成全部代码和集成验证，内网通过配置切换 Milvus、LLM、Embedding、Reranker 和 OCR。
4. 外网 LLM 使用用户提供的 DeepSeek Pro 兼容接口；其他能力优先采用可本地部署的开源实现。
5. 最终能力全量上线，但按语义模块依赖顺序增量实施和验收。
6. 前端使用 Vue 3 + Element Plus；AI 会话部分可以使用 Element Plus X。
7. 管理端必须展示上传和入库全链路的真实进度、失败原因、重试和审核状态。
8. 项目同时承担教学目标：实现者需要能够解释设计动机、执行链路、难点、故障处理和面试追问。

## 需求状态规则

- `[ ]`：未实现。
- `[~]`：实现中；只用于工作分支，合并前必须变成 `[ ]` 或 `[x]`。
- `[x]`：代码、测试、文档、可观测性和对应验收全部完成。
- `TBD`：需要真实内网信息或容量测试后确认，不阻塞使用安全默认值开发。

任何需求不得仅因“代码写完”而标记完成。模块验收记录使用语义化文件名写入 `docs/acceptance/`，例如 `hybrid-retrieval-acceptance.md`。

## 推荐实施顺序

```text
工程与决策基线 → 身份权限与知识空间 → 文档接入与任务 → 文件解析与OCR → 知识加工与质量 → 索引构建与发布
身份权限与知识空间 → 会话运行与事件
身份权限与知识空间 + 索引构建与发布 + 会话运行与事件 → 查询规划与混合检索 → 证据与答案生成
文档接入与任务 后并行开发管理端，会话运行与事件 后并行开发问答端
全部后端能力 + 前端 → 评测与生产可靠性 → Web 产品与全链路验收
现有 RAG 全链路验收 → 受控 Agentic RAG Auto → 可选 LLM Wiki 知识投影
```

## 需求追踪约定

- GitHub Issue/任务标题：`[RET-006] 实现加权 RRF`。
- 测试名称：`describe('[RET-006] weightedRrf', ...)`。
- JSDoc：`@requirement RET-006`。
- 验收记录引用需求编号及测试、Trace、截图或报告位置。
- 一个提交尽量只完成一个需求或一组强关联需求，方便学习和回溯。
