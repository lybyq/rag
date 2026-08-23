# 查询规划与混合检索 调试与故障定位

## 调试 API

```http
POST /api/v1/runs/{runId}/retrieval-debug
```

当前用户必须是 Run owner，且角色包含 `SYSTEM_ADMIN` 或 `AUDITOR`。该调用会真实访问 Provider，
所以使用 POST。普通用户不开放内部排名。

## 从结果判断故障层

| 现象                                 | 优先检查          | 常见原因                                        |
| ------------------------------------ | ----------------- | ----------------------------------------------- |
| route=CLARIFY                        | route_query       | 只有“这个呢”，且没有确认实体                    |
| planSource=DETERMINISTIC 且 degraded | rewrite_query     | LLM 未配置、超时或 Schema 错误                  |
| SPARSE_NOT_CONFIGURED                | Embedding Profile | 输出模式未包含 sparse                           |
| DENSE_FAILED/SPARSE_FAILED           | Milvus/网络       | Collection 未加载、字段不兼容、Deadline         |
| SOURCE_RECHECK_FAILED                | PostgreSQL        | 归档、Manifest/版本不匹配、未发布或不在生效窗口 |
| ACCESS_DENIED                        | 当前 ACL          | 权限在 Run 创建后被撤销                         |
| roundCount=2 仍为空                  | 数据/查询质量     | 应由 证据与答案生成 澄清或拒答，不继续循环      |

## Prometheus 指标

- `rag_retrieval_routes_total`
- `rag_retrieval_channel_routes_total`
- `rag_retrieval_embedding_cache_total`
- `rag_retrieval_removed_candidates_total`
- `rag_retrieval_stage_duration_seconds`

标签均为固定枚举。不要加入 question、runId、documentId 或 userId。

## 常用本地命令

```powershell
$env:TEMP='D:\coding\rag\.tmp'
$env:TMP='D:\coding\rag\.tmp'
pnpm db:migrate
pnpm exec jest --runInBand libs/rag-graph libs/retrieval libs/model-gateway
$env:RUN_INTEGRATION_TESTS='true'
pnpm exec jest --runInBand --config test/jest-integration.config.cjs test/integration/hybrid-retrieval-source.integration.spec.ts
```
