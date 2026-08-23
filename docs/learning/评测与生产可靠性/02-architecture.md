# 评测与生产可靠性：架构与链路

```text
Dataset/Case -> Evaluation Run 快照 -> Worker 执行/读取事实 -> Scorer
       |                   |                              |
       v                   v                              v
  不可变版本       Flow/Profile/Prompt/Manifest      Case Result
                                                        |
                                      Metrics + Variance + Baseline diff
                                                        |
                                             PR / Release Gate
```

生产控制面由 `OperationsService` 聚合 PostgreSQL 队列事实、服务心跳、Provider 非敏感健康、告警和 Feature Flag。浏览器只访问控制面 API，不能读取环境变量、Redis、Milvus 或模型密钥。

查询请求先由 Redis 流控原子脚本同时检查全局、用户、角色和空间配额，再进入 LangGraph。Run 创建时冻结 Flag 决策，运行中配置变化不改变既有 Run。模型适配器统一经过 resilience 包装，错误被归类后再决定重试、熔断或稳定失败。

发布链路使用 `Expand -> Migrate -> Contract`：先添加兼容结构，后台回填，再在所有旧版本退场后收紧约束。标签发布还必须通过真实 Evaluation Baseline，之后才构建带 SBOM、provenance 和提交 SHA 标签的 OCI 镜像。
