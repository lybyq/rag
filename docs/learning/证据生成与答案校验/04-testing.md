# 证据生成与答案校验：测试地图

| 风险                                            | 测试证据                                                 |
| ----------------------------------------------- | -------------------------------------------------------- |
| 契约漂移、Claim 无引用                          | `libs/contracts/src/answer-generation.spec.ts`           |
| 七条 Evidence Route                             | `libs/evidence/src/evidence-core.spec.ts` 与 Golden JSON |
| Prompt Injection、确定性计算                    | `libs/evidence/src/evidence-core.spec.ts`                |
| 伪造/撤销引用、金额日期不支持                   | `libs/answer/src/answer-validator.spec.ts`               |
| Reranker 超时/取消/429/5xx/Schema/版本/部分结果 | `reranker.adapter.spec.ts`                               |
| LLM Schema、取消、429、版本和未知 sourceId      | `answer-model.adapter.spec.ts`                           |
| 完整图、澄清短路、Reranker 降级                 | `answer-generation.graph.spec.ts`                        |
| Nest 真实依赖装配                               | `answer-generation.smoke.spec.ts`                        |
| PG 父/邻居/表头、过期、引用事务与反馈           | `hybrid-retrieval-source.integration.spec.ts`            |
| OpenAPI、迁移、Docker                           | 对应工程门禁脚本                                         |

## 为什么既要纯测试又要集成测试

纯函数测试能穷举路由和 Validator；Mock Provider 能稳定制造超时与坏 Schema；但 SQL JOIN、事务、
FK 和撤权只能由真实 PostgreSQL 证明。三层测试分别回答“规则是否正确、边界是否稳、基础设施事实
是否真的成立”，不能互相替代。

## 内网还要补什么

外网 Fixture 不能证明真实模型质量。内网需要批准脱敏 Golden，测 Citation Precision、Unsupported
Claim Rate、路由/拒答准确率、真实 Token、P95、429/5xx 降级、模型 revision 错配和长稳容量。
