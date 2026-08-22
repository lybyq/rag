# 外部能力与环境配置需求

## 1. 设计目标

业务代码不能知道当前使用的是外网开源服务还是内网企业服务。所有差异通过 Provider Profile、Port/Adapter 和环境变量处理，迁入内网时原则上只允许：

1. 修改非敏感 Profile；
2. 注入新的 Endpoint、密钥或证书；
3. 必要时新增一个实现相同 Port 的 Adapter；
4. 运行契约测试和兼容性检查。

不允许为了切换环境修改领域规则、Controller、Graph 节点或数据库事实模型。

## 2. 环境 Profile

| Profile               | 用途           | 外部依赖策略                                        |
| --------------------- | -------------- | --------------------------------------------------- |
| `test`                | 单元和契约测试 | 内存 Fake、固定 Fixture、Testcontainers             |
| `external-dev`        | 当前外网开发   | Docker 基础设施 + 本地开源模型服务 + DeepSeek API   |
| `external-ci`         | CI             | Testcontainers/Fake，不依赖个人密钥和不稳定公网模型 |
| `intranet-staging`    | 内网预生产     | 内网认证、Milvus 和模型测试端点                     |
| `intranet-production` | 内网生产       | 企业 Secret、HA 基础设施、正式模型 Gateway          |

Profile 文件只保存非敏感标识、能力和策略，密钥必须来自环境变量或 Secret Manager。

## 3. 统一 Provider 契约

### 3.1 通用要求

每个远程 Provider 必须提供或通过 Adapter 模拟以下能力：

```text
health()          可用性、依赖状态
metadata()        provider、model、revision、protocolVersion、capabilities
execute(...)      业务能力
```

Client 统一实现：

- Zod 请求/响应校验；
- 绝对 Deadline 与单次调用超时；
- `AbortSignal`；
- 429、临时 5xx 和网络错误的有限重试；
- 不重试认证失败、Schema 错误和确定性输入错误；
- 并发限制、熔断、指标和 OTel Span；
- Request ID/Trace ID 传播；
- 密钥、正文和模型原始响应脱敏。

### 3.2 Adapter 类型

| 类型                | 说明                                                |
| ------------------- | --------------------------------------------------- |
| `fake`              | 固定、可预测，仅用于单元/CI，绝不能作为质量评测结果 |
| `http`              | 项目定义的标准内部 HTTP 协议                        |
| `openai-compatible` | OpenAI-compatible Chat/Embedding 类接口             |
| `local-runtime`     | 由本仓库 Docker Compose 启动的本地开源服务          |
| `vendor-specific`   | 必须隔离在独立 Adapter，不能泄漏到业务层            |

## 4. 认证配置

```dotenv
AUTH_MODE=mock

# Mock，仅允许 local/test
AUTH_MOCK_USER_ID=dev-user
AUTH_MOCK_ROLES=KNOWLEDGE_READER,KNOWLEDGE_EDITOR,KNOWLEDGE_REVIEWER,KNOWLEDGE_ADMIN,SYSTEM_ADMIN,AUDITOR

# Trusted Header，Header 名可适配内网网关
AUTH_USER_HEADER=X-Authenticated-User
AUTH_ROLES_HEADER=X-Authenticated-Roles
AUTH_ROLES_SEPARATOR=,
AUTH_TRUSTED_PROXY_CIDRS=10.0.0.0/8
AUTH_HEADER_SIGNATURE_ENABLED=false
AUTH_HEADER_SIGNATURE_SECRET=

# JWT
AUTH_JWT_JWKS_URL=
AUTH_JWT_ISSUER=
AUTH_JWT_AUDIENCE=
AUTH_JWT_USER_ID_CLAIM=sub
AUTH_JWT_ROLES_CLAIM=roles
AUTH_JWT_ALLOWED_ALGORITHMS=RS256

# 内网角色到系统语义角色的映射，不含密钥
AUTH_ROLE_MAPPING_FILE=config/role-mapping.yaml
```

安全要求：

- `production` 禁止 `AUTH_MODE=mock`。
- Trusted Header 只能接受受信反向代理连接；代理必须删除客户端同名 Header 后重新注入。
- 角色映射中未出现的内网角色不自动获得任何权限。
- 认证上下文只包含 `userId`、映射后的角色、授权版本和解析时间。

## 5. 外网开发默认能力

### 5.1 基础设施

| 能力                | 外网方案                         | 备注                                         |
| ------------------- | -------------------------------- | -------------------------------------------- |
| PostgreSQL          | Docker 官方镜像                  | 业务事实源                                   |
| Redis Cache/Streams | Docker Redis                     | 与 BullMQ 使用不同逻辑实例或端口             |
| Redis BullMQ        | Docker Redis                     | 避免离线积压拖慢在线服务                     |
| MinIO               | Docker MinIO                     | 预签名上传和对象生命周期                     |
| Milvus              | Milvus Standalone Docker Compose | 免费开源，用于真实 Dense/Sparse 集成         |
| 内容安全预检        | 项目内置流式规则 Adapter         | EICAR/可执行魔数/大小上限；CI 可使用 Fixture |

### 5.2 AI 能力

| 能力      | 外网首选                             | 无 GPU/资源不足时                              |
| --------- | ------------------------------------ | ---------------------------------------------- |
| LLM       | 用户的 DeepSeek Pro，模型 ID 配置化  | CI 使用结构化 Fake；功能联调使用真实 API       |
| Embedding | 本地 BGE-M3 HTTP Runtime             | 单元/CI 用确定性 Fake；不得用 Fake 评估 Recall |
| Reranker  | 本地 bge-reranker-v2-m3 HTTP Runtime | 单元/CI 用固定分数 Fake                        |
| OCR       | 本地 PaddleOCR 类 HTTP Runtime       | Fixture OCR Adapter                            |
| Parser    | 项目自带 Node 多格式 Parser Runtime  | Fixture Parser Adapter                         |

“免费”指开源软件和本地推理，不假定第三方云服务持续提供免费额度。真实模型版本和镜像摘要以 lockfile、Profile Registry 与兼容性矩阵为准。

## 6. 环境变量基线

```dotenv
APP_ENV=development
APP_NAME=platform-api
PROVIDER_PROFILE=external-dev

DATABASE_URL=postgresql://rag:rag@localhost:5432/rag
REDIS_CACHE_URL=redis://localhost:6379/0
REDIS_STREAM_URL=redis://localhost:6379/1
REDIS_BULLMQ_URL=redis://localhost:6380/0

MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_UPLOAD_BUCKET=rag-quarantine
MINIO_SOURCE_BUCKET=rag-source
MINIO_DERIVED_BUCKET=rag-derived
MINIO_EXPORT_BUCKET=rag-export

UPLOAD_SESSION_TTL_SECONDS=3600
UPLOAD_PRESIGNED_URL_TTL_SECONDS=900
UPLOAD_MAX_FILES_PER_SESSION=100
UPLOAD_MAX_FILE_BYTES=2147483648
UPLOAD_MULTIPART_THRESHOLD_BYTES=16777216
UPLOAD_PART_SIZE_BYTES=8388608
INGESTION_LEASE_SECONDS=120

MILVUS_ADDRESS=localhost:19530
MILVUS_USERNAME=
MILVUS_PASSWORD=
MILVUS_DATABASE=default
MILVUS_COLLECTION_REGISTRY_FILE=config/milvus-collections.yaml

LLM_ADAPTER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL_ID=
LLM_PROFILE_ID=deepseek-dev-v1
LLM_CONNECT_TIMEOUT_MS=3000
LLM_REQUEST_TIMEOUT_MS=20000

EMBEDDING_ADAPTER=http
EMBEDDING_BASE_URL=http://localhost:8101
EMBEDDING_API_KEY=
EMBEDDING_PROFILE_ID=bge-m3-dev-v1
EMBEDDING_REQUEST_TIMEOUT_MS=30000

RERANKER_ADAPTER=http
RERANKER_BASE_URL=http://localhost:8102
RERANKER_API_KEY=
RERANKER_PROFILE_ID=bge-reranker-v2-m3-dev-v1
RERANKER_REQUEST_TIMEOUT_MS=10000

OCR_ADAPTER=http
OCR_BASE_URL=http://localhost:8103
OCR_API_KEY=
OCR_PROFILE_ID=ocr-dev-v1
OCR_REQUEST_TIMEOUT_MS=60000

PARSER_ADAPTER=http
PARSER_BASE_URL=http://localhost:8104
PARSER_API_KEY=
PARSER_PROFILE_ID=parser-dev-v1
PARSER_REQUEST_TIMEOUT_MS=120000

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

`.env.example` 只放空值或非敏感示例；真实 `.env` 必须被 Git 忽略。

### 6.1 M02 上传与执行配置说明

M02 参数在进程启动时由 Zod 校验并固化，当前均不支持热更新。调整后应滚动重启 API、Ingestion Worker 和 Scheduler；若新值引发异常，恢复上一个部署版本的环境变量并再次滚动重启。

| 环境变量                           | 默认值           | 合法范围/约束                          | 敏感 | 热更新 | 回退方式                                        |
| ---------------------------------- | ---------------- | -------------------------------------- | ---- | ------ | ----------------------------------------------- |
| `MINIO_UPLOAD_BUCKET`              | `rag-quarantine` | 非空 bucket 名；生产应配置生命周期清理 | 否   | 否     | 恢复原 bucket；迁移期间保留旧 bucket 读权限     |
| `UPLOAD_SESSION_TTL_SECONDS`       | `3600`           | `300..86400` 秒                        | 否   | 否     | 恢复原 TTL；已创建会话仍使用数据库中的过期时间  |
| `UPLOAD_PRESIGNED_URL_TTL_SECONDS` | `900`            | `60..3600` 秒，且不应大于会话 TTL      | 否   | 否     | 恢复原 TTL；客户端重新读取会话获取新 URL        |
| `UPLOAD_MAX_FILES_PER_SESSION`     | `100`            | `1..100`                               | 否   | 否     | 恢复原上限；不影响已创建会话                    |
| `UPLOAD_MAX_FILE_BYTES`            | `2147483648`     | `1..5368709120` 字节                   | 否   | 否     | 恢复原上限；不影响已创建文件计划                |
| `UPLOAD_MULTIPART_THRESHOLD_BYTES` | `16777216`       | `5242880..5368709120` 字节             | 否   | 否     | 恢复原阈值；已签发上传方式不变化                |
| `UPLOAD_PART_SIZE_BYTES`           | `8388608`        | `5242880..5368709120` 字节             | 否   | 否     | 恢复原分片；已创建 multipart 继续使用会话快照   |
| `INGESTION_LEASE_SECONDS`          | `120`            | `30..3600` 秒                          | 否   | 否     | 恢复原租约；等待旧租约过期后由 Scheduler 重排队 |

MinIO Access Key/Secret Key 属于敏感配置，只能通过本机 `.env`、CI Secret 或内网 Secret Manager 注入；轮换时应先让新旧凭据短暂并存，再滚动切换并撤销旧凭据。

### 6.2 M03 文件处理配置说明

| 环境变量                      | 默认值                       | 合法范围/能力约束                                              | 敏感       | 热更新 | 回退方式                                   |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------- | ---------- | ------ | ------------------------------------------ |
| `MINIO_DERIVED_BUCKET`        | `rag-derived`                | 与隔离上传 Bucket 不同；生产启用版本/生命周期                  | 否         | 否     | 恢复原 Bucket，并保留历史对象读权限        |
| `FILE_STREAM_TIMEOUT_MS`      | `600000`                     | `10000..3600000` 毫秒；覆盖完整对象流，不是单次 HEAD           | 否         | 否     | 按对象大小和带宽恢复旧 Deadline            |
| `SCANNER_ADAPTER`             | `builtin`                    | `builtin/fixture`；生产禁止 fixture                            | 否         | 否     | 切回上一 Scanner Profile 后滚动 Worker     |
| `SCANNER_REVISION`            | `1.0.0`                      | 修改任一内置签名/魔数规则必须升级 revision                     | 否         | 否     | 切回上一规则 revision                      |
| `SCANNER_REQUEST_TIMEOUT_MS`  | `60000`                      | `1000..300000` 毫秒                                            | 否         | 否     | 恢复旧超时，检查扫描吞吐后重排队           |
| `PARSER_ADAPTER`              | `http`                       | `docling/http/fixture`；默认 HTTP 指向项目 Node Parser Service | 否         | 否     | 切回上一不可变 Profile；旧 Run 保留修订    |
| `PARSER_BASE_URL`             | `http://localhost:8104`      | 合法 URL；生产使用 TLS/mTLS 或受控内网                         | 否         | 否     | 恢复旧 Endpoint，验证协议版本后重试        |
| `PARSER_API_KEY`              | 空                           | 仅 `http` Adapter 按需使用                                     | 是         | 否     | Secret Manager 回滚上一版本                |
| `PARSER_PROFILE_ID/REVISION`  | `node-multi-parser-v1/1.0.0` | 非空且历史含义不可原地修改                                     | 否         | 否     | 切回旧 Profile ID，不覆盖历史 Run          |
| `PARSER_PROTOCOL_VERSION`     | `2`                          | 必须与响应完全一致；v2 包含 `ocrCandidates`                    | 否         | 否     | Adapter 与 Provider 同步回滚               |
| `PARSER_REQUEST_TIMEOUT_MS`   | `180000`                     | `1000..600000` 毫秒                                            | 否         | 否     | 恢复旧超时；超时会终止调用并有限重试       |
| `PARSER_MAX_RESPONSE_BYTES`   | `104857600`                  | `1 MiB..512 MiB`                                               | 否         | 否     | 恢复旧上限；超限进入开发缺陷排查           |
| `PARSER_TEMP_ROOT`            | `.data/parser-runtime`       | 必须位于有容量的数据盘；不放系统盘                             | 否         | 否     | 切回旧目录并清理孤儿临时文件               |
| `PARSER_ALLOWED_SOURCE_HOSTS` | `localhost,127.0.0.1,minio`  | 精确主机白名单；禁止重定向和 URL 用户信息                      | 否         | 否     | 恢复上一白名单并重启 Parser                |
| `PARSER_MAX_INPUT_BYTES`      | `268435456`                  | `5 MiB..2 GiB`；超过时显式拒绝，不进入 Node 堆                 | 否         | 否     | 容量验证后调整并新建 Profile               |
| `PARSER_MAX_ARCHIVE_ENTRIES`  | `20000`                      | `10..1000000`；防止 ZIP 条目风暴                               | 否         | 否     | 恢复已验证上限                             |
| `PARSER_MAX_XML_ENTRY_BYTES`  | `33554432`                   | `1 MiB..512 MiB`；限制单个 OOXML 解析部件                      | 否         | 否     | 恢复已验证上限                             |
| `OCR_ADAPTER`                 | `docling`                    | `docling/http/fixture`；生产禁止 fixture                       | 否         | 否     | 切回上一 OCR Profile                       |
| `OCR_BASE_URL/API_KEY`        | `localhost:8103/空`          | 与 Parser 相同的网络/Secret 原则                               | API Key 是 | 否     | 回滚 Endpoint/Secret                       |
| `OCR_TEXT_COVERAGE_THRESHOLD` | `0.02`                       | `0..1`；按页判断                                               | 否         | 否     | 恢复旧阈值并新建 contentRevision 重处理    |
| `OCR_MIN_CONFIDENCE`          | `0.75`                       | `0..1`；低于阈值只告警，不伪造文字                             | 否         | 否     | 恢复旧阈值并重处理                         |
| `FILE_MAX_ARCHIVE_DEPTH`      | `3`                          | `1..20`                                                        | 否         | 否     | 恢复旧安全策略；不能为单文件绕过           |
| `FILE_MAX_COMPRESSION_RATIO`  | `100`                        | `1..10000`                                                     | 否         | 否     | 恢复旧安全策略                             |
| `FILE_MAX_PAGES`              | `2000`                       | `1..20000`                                                     | 否         | 否     | 恢复旧上限或走受控离线流程                 |
| `FILE_MAX_TOTAL_PIXELS`       | `500000000`                  | `1..100000000000`                                              | 否         | 否     | 恢复旧上限                                 |
| `FILE_MAX_TABLE_CELLS`        | `5000000`                    | `1..100000000`                                                 | 否         | 否     | 恢复旧上限                                 |
| `PROCESSING_MAX_ATTEMPTS`     | `3`                          | `1..10`                                                        | 否         | 否     | 恢复旧次数；达到上限后人工处理，不无限重试 |

项目自带 `document-parser-service` 是内外网默认 Parser，使用同一 `http` Adapter 与 v2 契约。外网仍可保留 Docling 作为免费 OCR/兼容路径，但 Docling 原生响应不能证明宏、嵌入对象和外链已完整检查，因此生产配置拒绝将它直接作为安全 Parser。内置 Scanner 只覆盖 EICAR、可执行魔数、大小和取消传播；Office 宏/嵌入对象/外链/压缩炸弹由 Node Parser 结构检查负责，它不等价于商业病毒库。

### 6.3 M04 知识加工与质量配置说明

| 环境变量                               | 默认值                            | 合法范围/能力约束                                              | 敏感 | 热更新 | 回退方式                             |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------- | ---- | ------ | ------------------------------------ |
| `CHUNKER_PROFILE_ID/REVISION`          | `structure-aware-medium-v1/1.0.0` | 非空且历史含义不可原地修改                                     | 否   | 否     | 切回旧 Profile，新建 revision 重处理 |
| `TOKENIZER_ADAPTER`                    | `cl100k`                          | 当前外网实现 `cl100k`；内网增加与 Embedding 精确匹配的 Adapter | 否   | 否     | 切回上一 Tokenizer Profile           |
| `TOKENIZER_PROFILE_ID`                 | `cl100k-base-local`               | 与 revision 一起进入 Run 快照                                  | 否   | 否     | 新建 revision，不覆盖旧 tokenCount   |
| `CHUNK_CHILD_MAX_TOKENS`               | `512`                             | `64..8192`                                                     | 否   | 否     | 恢复旧值并重处理                     |
| `CHUNK_PARENT_MAX_TOKENS`              | `1500`                            | `128..32768` 且不小于 Child                                    | 否   | 否     | 恢复旧值并重处理                     |
| `CHUNK_OVERLAP_TOKENS`                 | `64`                              | `0..2048` 且小于 Child                                         | 否   | 否     | 恢复旧值并重处理                     |
| `CHUNK_DEDUP_MODE`                     | `SUPPRESS`                        | `RETAIN/SUPPRESS`；两者都保留来源事实                          | 否   | 否     | 切回旧 Policy 并重处理               |
| `QUALITY_RULE_VERSION`                 | `quality-medium-v1`               | 非空；规则语义变化必须新版本                                   | 否   | 否     | 切回旧规则并新建 revision            |
| `QUALITY_MIN_NON_EMPTY_BLOCK_RATIO`    | `0.6`                             | `0..1`，不低于 reject 阈值                                     | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO` | `0.2`                             | `0..1`，不高于 manual 阈值                                     | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_MIN_OCR_CONFIDENCE`           | `0.75`                            | `0..1`                                                         | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_MAX_GARBLED_RATIO`            | `0.03`                            | `0..1`，不高于 reject 阈值                                     | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_REJECT_GARBLED_RATIO`         | `0.15`                            | `0..1`，不低于 manual 阈值                                     | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_MAX_DUPLICATE_RATIO`          | `0.4`                             | `0..1`                                                         | 否   | 否     | 恢复已评测阈值                       |
| `QUALITY_REQUIRE_HEADING_AFTER_BLOCKS` | `20`                              | `1..10000`                                                     | 否   | 否     | 恢复已评测阈值                       |

当前 `cl100k` 是无需云调用的真实 BPE 外网基线，不是内网 Embedding tokenizer 的替代承诺。切换模型或 tokenizer 必须创建新 Profile/revision、重跑 Chunk Golden 和检索评测；禁止原地改变历史 Profile 的含义。

### 6.4 M05 Embedding、Milvus 与 Profile Rollout 配置说明

| 环境变量                              | 默认值                 | 合法范围/能力约束                                                            | 敏感 | 热更新 | 回退方式                             |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- | ---- | ------ | ------------------------------------ |
| `EMBEDDING_ADAPTER`                   | `fixture`              | `fixture/http/openai-compatible`；内网 staging/production 必须为远程真实服务 | 否   | 否     | 滚动切回上一 Adapter/Profile         |
| `EMBEDDING_BASE_URL`                  | 本地占位               | HTTP Adapter 的服务根 URL；内网使用 TLS/mTLS 或受控网段                      | 否   | 否     | 恢复上一 Endpoint                    |
| `EMBEDDING_API_KEY`                   | 空                     | 仅通过 Secret 注入，不写 Git/日志                                            | 是   | 否     | Secret 版本回滚后滚动实例            |
| `EMBEDDING_PROFILE_ID`                | `fixture-embedding-v1` | 历史含义不可变；兼容字段变化必须新 ID                                        | 否   | 否     | 发起旧 Profile rollout 或请求级回退  |
| `EMBEDDING_MODEL_ID/REVISION`         | Fixture 值             | 必须与 `/metadata` 完全一致                                                  | 否   | 否     | 恢复模型部署和 Profile               |
| `EMBEDDING_PROTOCOL_VERSION`          | `1`                    | 当前项目 HTTP 协议版本                                                       | 否   | 否     | Adapter 与服务同步回滚               |
| `EMBEDDING_TOKENIZER_REVISION`        | Fixture 值             | 必须匹配生成 Chunk tokenCount 的模型 tokenizer                               | 否   | 否     | 新 contentRevision 重处理            |
| `EMBEDDING_DENSE_DIMENSION`           | `1024`                 | `1..65536`；现有 Registry 不一致直接拒绝                                     | 否   | 否     | 使用旧 Profile/Collection            |
| `EMBEDDING_NORMALIZE_DENSE`           | `true`                 | 响应范数误差超过 0.02 拒绝                                                   | 否   | 否     | 恢复旧模型输出策略                   |
| `EMBEDDING_OUTPUT_MODES`              | `dense`                | `dense` 或 `dense,sparse`；Sparse 变化创建新 Collection                      | 否   | 否     | 回退旧 Profile                       |
| `EMBEDDING_SPARSE_FORMAT_VERSION`     | 空                     | 启用 sparse 时必填且与 metadata 一致                                         | 否   | 否     | 回退旧 Profile                       |
| `EMBEDDING_DOCUMENT_TEMPLATE_VERSION` | `document-v1`          | 文档输入模板的不可变版本                                                     | 否   | 否     | 新 Profile 全量重建                  |
| `EMBEDDING_QUERY_TEMPLATE_VERSION`    | `query-v1`             | 查询输入模板的不可变版本                                                     | 否   | 否     | 新 Profile 全量重建                  |
| `EMBEDDING_MAX_BATCH_TOKENS`          | `8192`                 | 不小于单条最大输入；按内网显存压测                                           | 否   | 否     | 恢复安全批次预算                     |
| `EMBEDDING_MAX_CONCURRENCY`           | `2`                    | `1..64`；避免压垮共享内网模型                                                | 否   | 否     | 降回已验证并发                       |
| `EMBEDDING_MAX_ATTEMPTS`              | `3`                    | `1..10`；只重试 429/5xx/timeout 明确失败项                                   | 否   | 否     | 恢复旧次数                           |
| `EMBEDDING_MAX_QUEUED_ITEMS`          | `2048`                 | 显式背压上限                                                                 | 否   | 否     | 降低入口并发或扩容 Worker            |
| `VECTOR_STORE_ADAPTER`                | `memory`/`milvus`      | 外网 Fixture 可用 memory；内网必须 milvus                                    | 否   | 否     | 切回旧应用配置                       |
| `MILVUS_ADDRESS/DATABASE`             | 本地默认               | 内网集群地址与批准 database                                                  | 否   | 否     | 恢复旧 Endpoint                      |
| `MILVUS_TOKEN/PASSWORD`               | 空                     | Secret 注入                                                                  | 是   | 否     | 凭据版本回滚                         |
| `MILVUS_COLLECTION_PREFIX`            | `rag_chunks`           | 服务端生成 Collection 名，客户端不可传                                       | 否   | 否     | Registry 保留旧映射                  |
| `INDEXING_MANIFEST_RETENTION_DAYS`    | `30`                   | `1..3650`；必须覆盖回退观察期                                                | 否   | 否     | 延长保留期不会影响当前 Head          |
| `INDEXING_RECONCILE_INTERVAL_SECONDS` | `3600`                 | `60..604800`                                                                 | 否   | 否     | 恢复旧频率                           |
| `INDEXING_ROLLOUT_MAX_CASES`          | `50`                   | `1..1000` 个文档代表查询                                                     | 否   | 否     | 恢复旧样本预算                       |
| `INDEXING_ROLLOUT_EVALUATION_TOP_K`   | `5`                    | `1..100`                                                                     | 否   | 否     | 恢复已审批 K                         |
| `INDEXING_ROLLOUT_MINIMUM_RECALL`     | `0.9`                  | `0..1`；内网以业务评测确定                                                   | 否   | 否     | 回退阈值需审批，不可为通过而临时降低 |
| `INDEXING_ROLLOUT_LEASE_SECONDS`      | `600`                  | `30..3600`                                                                   | 否   | 否     | 等旧 lease 过期后重领                |

`fixture + memory` 只用于流程与事务测试。真实 Recall、Milvus 性能和内网网络故障必须在 `intranet-staging` 复验。

## 7. Profile Registry

Profile 必须是不可变、可引用的配置事实。修改模型或关键参数时创建新 Profile ID，不原地改变历史含义。

```ts
/**
 * 模型能力的通用版本信息。
 * Run 和入库任务保存 profileId，以便重现历史结果。
 */
export interface ProviderMetadata {
  provider: string;
  modelId: string;
  revision: string;
  protocolVersion: string;
  capabilities: string[];
}

export interface EmbeddingProviderMetadata extends ProviderMetadata {
  denseDimension: number;
  normalizeDense: boolean;
  sparseFormatVersion: string;
  tokenizerRevision: string;
  maxInputTokens: number;
}
```

启动检查至少验证：

- 服务可达并且协议版本受支持；
- 配置模型与服务实际模型一致；
- Embedding 维度、归一化、Sparse 格式和 Tokenizer 一致；
- Reranker 支持所需批量大小与最大 Token；
- OCR 返回页码、坐标、置信度和引擎版本；
- LLM 支持所需结构化输出，或 Adapter 能可靠执行 Schema 修复/拒绝。

## 8. 内网切换流程

1. 收集认证 Header/JWT、Provider Endpoint、证书、网络和模型元数据。
2. 创建 `intranet-staging` Profile，不修改 `external-dev`。
3. 为协议不同的能力新增 Adapter；协议相同则只修改配置。
4. 运行全部 Provider 契约测试和启动兼容性检查。
5. 用同一批脱敏 Golden 文档执行解析、Embedding、Reranker、OCR 和问答对比。
6. 建立新 Embedding Collection/Profile，禁止把不同维度写入现有 Collection。
7. 执行中型规模 Load/Soak，记录实际吞吐、并发和资源余量。
8. 灰度切换新 Profile；Run 锁定版本，已开始的任务不跨 Profile。
9. 验证回退后再进入生产审批。

## 9. 配置验收清单

- [ ] `CFG-001` 所有 Provider 均可通过 Profile 切换，无业务层条件分支。
- [x] `CFG-002` test/CI 不依赖个人 DeepSeek 密钥或公网服务。
- [x] `CFG-003` production 检测到 Mock Auth、Fake Provider 或默认密钥时拒绝启动。
- [ ] `CFG-004` Profile 与实际 Provider 元数据不兼容时健康检查失败。
- [ ] `CFG-005` 密钥不进入 Git、日志、Trace、前端 Bundle、镜像层或错误响应。
- [ ] `CFG-006` 内外网 Provider 使用同一套契约测试。
- [ ] `CFG-007` 每个 Run/Job 保存实际使用的 Profile 与 revision。
- [ ] `CFG-008` Provider 切换、灰度和回退均有审计记录。
- [ ] `CFG-009` Feature Flag 按系统/知识空间配置并进入 Run 快照。
- [x] `CFG-010` M02 配置文档包含默认值、范围、敏感性、是否热更新和回退方式；后续 Provider 模块按同一表格补齐。
- [x] `CFG-011` 离线依赖 Manifest 固定 Node/pnpm、目标平台、Native 模块和安装脚本白名单，严格模式拒绝未锁镜像摘要。
- [x] `CFG-012` Profile 文件使用白名单映射，部署环境/Secret 覆盖文件值，运行时永不读取 `.example`。
- [x] `CFG-013` 外网联网构建、内网离线构建和内网预构建镜像部署分别有 Docker 入口与静态门禁。

双环境配置、Docker、离线依赖和已知验收缺口的证据见 [Provider 双环境与离线部署实施证据](./DUAL_ENV_IMPLEMENTATION_EVIDENCE.md)，操作步骤见 [Provider 双环境切换与内网离线部署 Runbook](../runbooks/provider-profile-and-airgap-deployment.md)。`CFG-001/004/006/007` 仍需随 M05、M07、M08 补齐所有 Provider 和所有 Run，当前不得整体勾选。
