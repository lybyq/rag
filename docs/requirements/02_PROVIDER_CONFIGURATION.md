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

| 能力                | 外网方案                         | 备注                                          |
| ------------------- | -------------------------------- | --------------------------------------------- |
| PostgreSQL          | Docker 官方镜像                  | 业务事实源                                    |
| Redis Cache/Streams | Docker Redis                     | 与 BullMQ 使用不同逻辑实例或端口              |
| Redis BullMQ        | Docker Redis                     | 避免离线积压拖慢在线服务                      |
| MinIO               | Docker MinIO                     | 预签名上传和对象生命周期                      |
| Milvus              | Milvus Standalone Docker Compose | 免费开源，用于真实 Dense/Sparse 集成          |
| 恶意软件扫描        | ClamAV 类本地 Adapter            | 开发可使用 EICAR 测试文件验证，CI 可使用 Fake |

### 5.2 AI 能力

| 能力      | 外网首选                             | 无 GPU/资源不足时                              |
| --------- | ------------------------------------ | ---------------------------------------------- |
| LLM       | 用户的 DeepSeek Pro，模型 ID 配置化  | CI 使用结构化 Fake；功能联调使用真实 API       |
| Embedding | 本地 BGE-M3 HTTP Runtime             | 单元/CI 用确定性 Fake；不得用 Fake 评估 Recall |
| Reranker  | 本地 bge-reranker-v2-m3 HTTP Runtime | 单元/CI 用固定分数 Fake                        |
| OCR       | 本地 PaddleOCR 类 HTTP Runtime       | Fixture OCR Adapter                            |
| Parser    | 本地隔离 Parser Runtime              | Fixture Parser Adapter                         |

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

| 环境变量                      | 默认值                                     | 合法范围/能力约束                                               | 敏感       | 热更新 | 回退方式                                   |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------- | ---------- | ------ | ------------------------------------------ |
| `MINIO_DERIVED_BUCKET`        | `rag-derived`                              | 与隔离上传 Bucket 不同；生产启用版本/生命周期                   | 否         | 否     | 恢复原 Bucket，并保留历史对象读权限        |
| `FILE_STREAM_TIMEOUT_MS`      | `600000`                                   | `10000..3600000` 毫秒；覆盖完整对象流，不是单次 HEAD            | 否         | 否     | 按对象大小和带宽恢复旧 Deadline            |
| `SCANNER_ADAPTER`             | `clamd`                                    | `clamd/fixture`；生产禁止 fixture                               | 否         | 否     | 切回上一 Scanner Profile 后滚动 Worker     |
| `SCANNER_REVISION`            | `ClamAV 1.4.3`                             | 匹配 clamd `VERSION` 前缀；Run 保存实际签名库 revision          | 否         | 否     | 镜像与 Profile 同步回滚                    |
| `CLAMD_HOST/PORT`             | `localhost/3310`                           | TCP 只能开放给 Worker 网段，clamd 本身无认证                    | 否         | 否     | 恢复旧服务地址；失败任务按 lease 重试      |
| `SCANNER_REQUEST_TIMEOUT_MS`  | `60000`                                    | `1000..300000` 毫秒                                             | 否         | 否     | 恢复旧超时，检查扫描吞吐后重排队           |
| `PARSER_ADAPTER`              | `docling`                                  | `docling/http/fixture`；生产必须用具备完整结构安全检查的 `http` | 否         | 否     | 切回上一不可变 Profile；旧 Run 保留修订    |
| `PARSER_BASE_URL`             | `http://localhost:8104`                    | 合法 URL；生产使用 TLS/mTLS 或受控内网                          | 否         | 否     | 恢复旧 Endpoint，验证协议版本后重试        |
| `PARSER_API_KEY`              | 空                                         | 仅 `http` Adapter 按需使用                                      | 是         | 否     | Secret Manager 回滚上一版本                |
| `PARSER_PROFILE_ID/REVISION`  | `docling-standard-dev-v1/docling-serve-v1` | 非空且历史含义不可原地修改                                      | 否         | 否     | 切回旧 Profile ID，不覆盖历史 Run          |
| `PARSER_PROTOCOL_VERSION`     | `1`                                        | 必须与响应完全一致                                              | 否         | 否     | Adapter 与 Provider 同步回滚               |
| `PARSER_REQUEST_TIMEOUT_MS`   | `180000`                                   | `1000..600000` 毫秒                                             | 否         | 否     | 恢复旧超时；超时会终止调用并有限重试       |
| `PARSER_MAX_RESPONSE_BYTES`   | `104857600`                                | `1 MiB..512 MiB`                                                | 否         | 否     | 恢复旧上限；超限进入开发缺陷排查           |
| `PARSER_TEMP_ROOT`            | `.data/parser-runtime`                     | 必须位于有容量的数据盘；不放系统盘                              | 否         | 否     | 切回旧目录并清理孤儿临时文件               |
| `OCR_ADAPTER`                 | `docling`                                  | `docling/http/fixture`；生产禁止 fixture                        | 否         | 否     | 切回上一 OCR Profile                       |
| `OCR_BASE_URL/API_KEY`        | `localhost:8103/空`                        | 与 Parser 相同的网络/Secret 原则                                | API Key 是 | 否     | 回滚 Endpoint/Secret                       |
| `OCR_TEXT_COVERAGE_THRESHOLD` | `0.02`                                     | `0..1`；按页判断                                                | 否         | 否     | 恢复旧阈值并新建 contentRevision 重处理    |
| `OCR_MIN_CONFIDENCE`          | `0.75`                                     | `0..1`；低于阈值只告警，不伪造文字                              | 否         | 否     | 恢复旧阈值并重处理                         |
| `FILE_MAX_ARCHIVE_DEPTH`      | `3`                                        | `1..20`                                                         | 否         | 否     | 恢复旧安全策略；不能为单文件绕过           |
| `FILE_MAX_COMPRESSION_RATIO`  | `100`                                      | `1..10000`                                                      | 否         | 否     | 恢复旧安全策略                             |
| `FILE_MAX_PAGES`              | `2000`                                     | `1..20000`                                                      | 否         | 否     | 恢复旧上限或走受控离线流程                 |
| `FILE_MAX_TOTAL_PIXELS`       | `500000000`                                | `1..100000000000`                                               | 否         | 否     | 恢复旧上限                                 |
| `FILE_MAX_TABLE_CELLS`        | `5000000`                                  | `1..100000000`                                                  | 否         | 否     | 恢复旧上限                                 |
| `PROCESSING_MAX_ATTEMPTS`     | `3`                                        | `1..10`                                                         | 否         | 否     | 恢复旧次数；达到上限后人工处理，不无限重试 |

外网 `docling` Adapter 用于免费功能联调，但 Docling 原生响应不能证明宏、嵌入对象和外链已经完整检查，因此生产配置会拒绝将它直接作为安全 Parser。内网 `http` Adapter 必须返回完整 `FileStructureInspection`；响应缺字段、协议或修订不一致会 fail closed。

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
- [ ] `CFG-002` test/CI 不依赖个人 DeepSeek 密钥或公网服务。
- [ ] `CFG-003` production 检测到 Mock Auth、Fake Provider 或默认密钥时拒绝启动。
- [ ] `CFG-004` Profile 与实际 Provider 元数据不兼容时健康检查失败。
- [ ] `CFG-005` 密钥不进入 Git、日志、Trace、前端 Bundle、镜像层或错误响应。
- [ ] `CFG-006` 内外网 Provider 使用同一套契约测试。
- [ ] `CFG-007` 每个 Run/Job 保存实际使用的 Profile 与 revision。
- [ ] `CFG-008` Provider 切换、灰度和回退均有审计记录。
- [ ] `CFG-009` Feature Flag 按系统/知识空间配置并进入 Run 快照。
- [x] `CFG-010` M02 配置文档包含默认值、范围、敏感性、是否热更新和回退方式；后续 Provider 模块按同一表格补齐。
