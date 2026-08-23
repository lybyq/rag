# M07 实施证据

## 需求映射

- RET-001～005：`contracts/retrieval.ts`、字面量、路由与查询计划算法。
- RET-006～007：FilterCompiler、Milvus UUID Filter、PG 参数化回源和无表达式 HTTP 契约。
- RET-008：锁定 Profile/模型/revision/dimension 校验与 Redis scope-aware Key。
- RET-009～011：LangGraph hybrid 节点、加权 RRF 和多样性算法。
- RET-012～013：M07 vectorId 索引与 PostgreSQL 单批复核。
- RET-014～015：Run snapshot Retrieval Profile 与唯一两轮回边。
- RET-016：授权 debug Controller、脱敏 DTO、Prometheus 指标和真实 Nest Composition Root 冒烟测试。
- RET-017：黄金集和真实 PostgreSQL 集成测试。

## 内网配置边界

LLM、Embedding 和 Milvus 通过 Provider Profile 配置；代码不包含内网地址或密钥。外网 Fixture 可验证
控制流，不能签署真实 Recall/P95。上线人员必须用内网批准的模型 revision、Collection 和业务脱敏
Golden 复验，结果随发布单归档。

`RETRIEVAL_PROFILE_ID` 代表当前部署批准给知识空间使用的检索 Profile；它的 TopK、RRF、权重和
多样性参数全部冻结进 Run。首个中型规模版本只允许一次 Run 使用一个兼容 Profile，跨空间混用
不兼容的 Embedding Profile 会 fail-closed。后续 WEB-008 只负责提供管理界面，不能绕过本契约。
