# 企业 RAG 内网应用发布包

这个目录同时支持两种落地方式：

1. 在外网构建六个 Linux 镜像，带到无网内网后执行 `docker load` 并连接现有基础设施。
2. 把完整源码带入内网，在 D 盘直接运行六个开发进程，仍连接同一套外部服务。

只复制本目录可以完成 Docker 部署；源码运行必须额外复制完整仓库，并保留隐藏目录
`.offline/pnpm-store`。两种方式使用同一份 `.env`，区别只是应用跑在容器里还是 Node 进程里。

当前阶段使用 `external-dev + development + mock` 做单一管理员身份联调。这不是关闭权限：所有业务请求仍会经过项目的权限链，只是身份由固定 Mock 用户产生。依赖调通后，再改三个鉴权配置切入企业 SSO/网关。

## 1. 交付边界

镜像包只包含下列六个应用，不包含任何基础设施或模型镜像：

| 应用                      | 职责                                      |     容器端口 |
| ------------------------- | ----------------------------------------- | -----------: |
| `platform-api`            | 知识库、空间、上传、任务、权限和运维 API  |         3000 |
| `rag-query-service`       | 会话、LangGraph 问答、SSE、引用           |         3001 |
| `ingestion-worker`        | BullMQ 文档加工、Embedding、Milvus 建索引 | 3002（探针） |
| `scheduler-worker`        | 维护、发布、评测和补偿任务                | 3003（探针） |
| `document-parser-service` | PDF/Office/HTML/Markdown/文本等解析       |         8104 |
| `web-console`             | Vue 管理端、聊天端和同源 Nginx 网关       |         8080 |

内网必须已经提供：

- PostgreSQL；
- 两个独立 Redis：一个用于 Cache，一个用于 BullMQ；
- Milvus；
- GLM-4.7 的 OpenAI-compatible 网关；
- Embedding HTTP 服务；
- Reranker HTTP 服务；
- 满足本项目契约的 PaddleOCR 网关；
- **MinIO 或兼容本项目 MinIO SDK 的 S3 对象存储**。

最后一项不能省略。上传原文件、派生文件、解析源和引用证据都依赖对象存储；如果内网现在没有，先申请一套 MinIO/S3 兼容服务，否则只能做部分进程启动，无法完成“上传到问答”的闭环。

## 2. 目录说明

| 文件                                             | 用途                                             |
| ------------------------------------------------ | ------------------------------------------------ |
| `.env.example`                                   | 运行时变量模板；复制成 `.env` 后填真实地址       |
| `images.env.example`                             | 六个镜像变量的格式示例                           |
| `images.env`                                     | 构建脚本生成，记录本包实际的六个精确 Tag         |
| `docker-compose.yml`                             | 只编排六个应用和一次性 Bootstrap，不启动外部依赖 |
| `build-release.ps1`                              | 外网构建、质量门禁、断网构建证明、导出和签摘要   |
| `verify.*`                                       | 校验整个交付目录的 SHA-256                       |
| `load-images.*`                                  | 校验后导入并确认六个 Tag                         |
| `preflight.*`                                    | 检查占位符、Compose、镜像和外部基础设施          |
| `start.*` / `status.*` / `stop.*`                | 启动、诊断、停止 Docker 部署                     |
| `local-run.*`                                    | 内网源码方式启动                                 |
| `provider-http-contracts.md`                     | 构建时复制，交给模型/OCR 服务团队联调            |
| `rag-apps.tar`                                   | 六个应用镜像的离线归档                           |
| `IMAGE-MANIFEST.json` / `VERSION` / `SHA256SUMS` | 镜像元数据、版本和完整性摘要                     |

`.env` 含真实凭据，不进入 SHA 文件、不进入镜像，也不应提交 Git。

## 3. 外网构建六个镜像

要求：Docker Engine、Docker Compose v2、Node 22.20+、pnpm 11.19+；工作区和 Docker 数据尽量放 D 盘。

```powershell
Set-Location D:\coding\rag
corepack enable
pnpm install --frozen-lockfile
.\rag-intranet-release\build-release.ps1 -Version 0.1.0-intranet -Platform linux/amd64
```

如果内网主机是 ARM64，把平台改成 `linux/arm64`。脚本默认拒绝脏工作区；确实要把当前未提交修改做成测试制品时使用 `-AllowDirty`，产物 Tag 和清单会明确带 `dirty`。已有生成物需要重建时再加 `-ForceArtifacts`。

脚本会执行：

1. `pnpm check` 完整门禁；
2. 准备 `.offline/pnpm-store`；
3. 拉取锁定 SHA-256 摘要的 Node/Nginx 基础镜像；
4. 用 `--network=none` 构建五个后端和一个 Web 镜像；
5. 只把六个运行镜像保存到 `rag-apps.tar`；
6. 生成实际 `images.env`、镜像清单、版本和全目录 SHA-256。

因此应用构建阶段不会临时访问 npm，内网也不需要 Registry 或 Node/pnpm。

## 4. 内网 Docker 部署

把整个 `rag-intranet-release` 目录复制到内网服务器，不要只复制 tar。

内网机器只需要 Docker Engine 和 Docker Compose v2，不需要 Node、pnpm、Git，也不需要镜像仓库。
先用 `docker version` 和 `docker compose version` 确认命令可用。Linux 主机必须与构建平台一致；
本包默认是 `linux/amd64`，不能拿到 ARM64 主机直接运行。

### 4.1 填配置

Windows：

```powershell
Copy-Item .env.example .env
notepad .env
```

Linux：

```bash
cp .env.example .env
vi .env
chmod +x ./*.sh
```

必须替换全部 `<...>`。特别注意：

- `REDIS_CACHE_URL` 和 `REDIS_BULLMQ_URL` 填两个独立实例，通常各用 `/0`；BullMQ 实例建议开启持久化并设置 `noeviction`。
- `MINIO_ENDPOINT` 的主机名必须同时可被容器和用户浏览器解析，因为浏览器会直接使用预签名 URL 上传。
- 若对象存储账号无建桶权限，让管理员预建 `rag-quarantine`、`rag-derived`、`rag-documents`、`rag-artifacts`，然后设 `STORAGE_INIT_ENABLED=false`。
- `LLM_BASE_URL` 通常以 `/v1` 结尾；应用会继续拼接 `/chat/completions`。GLM-4.7 网关必须支持 OpenAI-compatible JSON object 输出。
- 默认使用纯 Dense 检索。只有 Embedding `/metadata` 明确返回 `sparse` 能力，且输出满足契约，才能把 `EMBEDDING_OUTPUT_MODE` 改成 `dense,sparse`、填写稀疏格式版本，并恢复 Dense/Sparse 权重。
- `RUN_CONTENT_ENCRYPTION_KEY` 用随机 32 字节的 Base64；写入数据后必须长期保留，不能随意轮换。
- PaddleOCR 原生接口通常不等于本项目 `/v1/ocr` 契约。若现有地址不匹配，需要在它前面部署一个很薄的适配网关。

PowerShell 生成加密密钥：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Linux 生成：

```bash
openssl rand -base64 32
```

### 4.2 校验、装载和启动

Windows：

```powershell
.\verify.ps1
.\load-images.ps1
.\preflight.ps1
.\start.ps1 -SkipLoad
.\status.ps1
```

Linux：

```bash
./verify.sh
./load-images.sh
./preflight.sh
SKIP_LOAD=true ./start.sh
./status.sh
```

`preflight` 会在一次性容器内执行项目自己的深度健康检查，验证配置以及 PostgreSQL、两个 Redis、MinIO/S3、Milvus。模型和 OCR 的完整契约需要按 `provider-http-contracts.md` 发真实请求联调，因为 LLM/Reranker/OCR 属于按需调用，不能用一个“端口通”冒充可用。

临时排查防火墙时可以使用 `preflight.ps1 -SkipConnectivity` 或 `SKIP_CONNECTIVITY=true ./preflight.sh`，但这个结果不能作为上线验收。

Bootstrap 会先执行数据库迁移，再按配置幂等建桶。成功后六个应用才启动。所有命令都带 `--no-build --pull never`，内网不会尝试拉镜像。

访问地址：`http://<内网服务器IP>:<WEB_BIND端口>`。默认只暴露 Web 的 8080，其他应用只在 Compose 专用网络中可达。

停止不会碰外部数据：

```powershell
.\stop.ps1
```

```bash
./stop.sh
```

### 4.3 怎么看是否真的启动成功

Windows：

```powershell
.\status.ps1
docker compose --env-file images.env --env-file .env -f docker-compose.yml ps
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 bootstrap
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 ingestion-worker
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 rag-query-service
```

Linux：

```bash
./status.sh
docker compose --env-file images.env --env-file .env -f docker-compose.yml ps
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 bootstrap
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 ingestion-worker
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 200 rag-query-service
```

判断方法：

- `bootstrap` 必须显示 `Exited (0)`；不是 0 就先修数据库迁移或 MinIO 建桶问题。
- 六个长期服务必须是 `Up`，带健康检查的服务最终应显示 `healthy`。
- 页面能打开只证明 Web 正常；必须再上传文档并真实提问，才能证明模型链路正常。
- `preflight` 只检查 PG、两个 Redis、MinIO、Milvus；它不会假装调用一次模型就代表模型质量合格。

### 4.4 更新和回退

更新时保留旧发布目录，再复制一个新版本目录。新目录执行：

```powershell
.\verify.ps1
.\load-images.ps1
Copy-Item ..\旧版本\.env .env
.\preflight.ps1
.\start.ps1 -SkipLoad
```

Linux 使用同名 `.sh` 脚本。`start` 会先跑幂等数据库迁移，再使用新 `images.env` 滚动创建容器。
需要回退时进入旧目录重新执行 `start`。数据库迁移必须遵守 Expand→Migrate→Contract；如果新版本已经
执行不可向后兼容的 Contract 迁移，不能直接回退镜像。

## 5. 模型服务最小契约

| 服务           | 应用实际调用                                          |
| -------------- | ----------------------------------------------------- |
| GLM-4.7        | `POST {LLM_BASE_URL}/chat/completions`                |
| Embedding      | `GET /health`、`GET /metadata`、`POST /v1/embeddings` |
| Reranker       | `GET /health`、`GET /v1/metadata`、`POST /v1/rerank`  |
| PaddleOCR 网关 | `POST /v1/ocr`，协议版本 2                            |
| Milvus         | SDK 地址 `host:19530`，不是 Attu/网页地址             |

模型 ID、不可变 revision、协议版本、向量维度、是否归一化、Tokenizer revision 必须与服务真实元数据一致。这里采用 fail-closed：不一致就停止写索引，避免“接口返回 200，但向量维度或模型版本错了”悄悄污染知识库。

### 5.1 怎么判断只改 env，还是必须加 Adapter

先不要看服务名字，看“请求地址、请求 JSON、响应 JSON”是否一致。完整样例在
`provider-http-contracts.md`。

| 现象                                                        | 结论                 | 怎么处理                                                |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| 路径、请求字段、响应字段完全一致                            | 不需要 Adapter       | 只填 `.env`                                             |
| 401/403                                                     | 凭据或鉴权方式错     | 改 Key、Header、证书或网关，不要写 Adapter 掩盖权限问题 |
| 404                                                         | 路径不一致           | 很薄的网关改路径，或新增 Adapter                        |
| 429、5xx、超时                                              | 容量、限流或网络问题 | 调并发/超时、扩容、查防火墙；这不是响应转换问题         |
| HTTP 200，但日志出现 `SCHEMA_ERROR`、`SCHEMA_MISMATCH`      | JSON 形状不同        | 新增 Adapter 或在模型前加转换网关                       |
| `VERSION_MISMATCH`、维度不一致、模型 ID 不一致              | 连错模型或 env 填错  | 修 env/服务；禁止用 Adapter 伪造版本和维度              |
| 模型根本不支持结构化 JSON、OCR 没坐标、Embedding 没固定维度 | 能力缺失             | 换模型或建设能补齐能力的网关；简单字段改名解决不了      |

最容易误判的是“HTTP 200”。200 只代表对方收到了请求，不代表返回内容能用于本项目。

现有 Adapter 的选择：

| 能力      | env 值                          | 对方必须返回什么                                                                           |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| LLM       | `LLM_ADAPTER=openai-compatible` | OpenAI Chat Completions 形状，答案在 `choices[0].message.content`，content 必须是合法 JSON |
| LLM       | `LLM_ADAPTER=http`              | 本项目三个结构化接口：`v1/answer/generate`、`v1/answer/evidence-rerank`、`v1/answer/judge` |
| Embedding | `EMBEDDING_ADAPTER=http`        | `/health`、`/metadata`、`/v1/embeddings`，响应满足本项目批量成功/部分失败契约              |
| Reranker  | `RERANKER_ADAPTER=http`         | `/health`、`/v1/metadata`、`/v1/rerank`                                                    |
| OCR       | `OCR_ADAPTER=http`              | `/v1/ocr`，包含 targetId、页码、0～1 bbox、置信度、引擎 revision                           |

PaddleOCR 原生服务通常只返回自己的字段，所以一般有两种做法：

1. 推荐：在 PaddleOCR 前放一个很薄的 Python/Java 网关，把原始结果转成 `provider-http-contracts.md` 的 `/v1/ocr`；RAG 代码不用改。
2. 对方协议长期稳定且只能由本项目维护：在 TypeScript 中新增 OCR Adapter。

### 5.2 加 Adapter 的固定套路

Adapter 的作用只有一个：把供应商协议翻译成项目 Port。它不能改权限、业务规则、LangGraph、数据库，
也不能伪造模型版本或向量维度。

按下面顺序开发：

1. 先保存一份脱敏后的真实请求和响应，确认差异到底是路径、鉴权、字段还是能力缺失。
2. 找到对应 Port，Port 是项目内部永远不随供应商变化的接口。
3. 新建供应商 Adapter：组装供应商请求，调用远程服务，把响应转换并用 Zod 校验后返回 Port 类型。
4. 在配置白名单加入新的 Adapter 名称，例如 `glm-vendor` 或 `paddle-raw`。
5. 在 Composition Root 根据 env 选择新 Adapter。业务 Service、Controller、LangGraph 不允许出现供应商判断。
6. 补齐正常、超时、取消、Schema 错误、401/403、429、5xx、版本不匹配和部分失败测试。
7. 重新执行本目录 `build-release.ps1`；只改源码但不重建镜像，内网仍然运行旧代码。

对应代码位置：

| 能力      | Port                                                                 | Adapter 放置位置                      | 选择 Adapter 的模块                   |
| --------- | -------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| LLM       | `AnswerModelPort`，`libs/application/src/answer-generation.ports.ts` | `libs/model-gateway/src/`             | `answer-model-gateway.module.ts`      |
| Embedding | `EmbeddingPort`，`libs/application/src/indexing.ports.ts`            | `libs/model-gateway/src/`             | `embedding-gateway.module.ts`         |
| Reranker  | `RerankerPort`，`libs/application/src/answer-generation.ports.ts`    | `libs/model-gateway/src/`             | `reranker-gateway.module.ts`          |
| OCR       | `OcrPort`，`libs/application/src/document-processing.ports.ts`       | `libs/file-processing-providers/src/` | `file-processing-providers.module.ts` |

配置白名单统一在 `libs/config/src/app-config.ts`。例如增加 `paddle-raw` 时，先把它加入
`ocrAdapters`，再在 `FileProcessingProvidersModule` 中创建 `PaddleRawOcrAdapter`。只改 env 写一个
代码不认识的名字，应用会在启动时直接拒绝，这是正确行为。

Adapter 至少必须保留这些生产能力：

- 使用配置的单次超时、总 Deadline 和 `AbortSignal`；用户取消后必须停止远程请求。
- 只重试网络错误、429 和临时 5xx；401、Schema 错误、版本错误不能重试。
- 用 Zod 校验供应商响应，并限制响应大小。
- 日志只能记录错误分类、模型 ID、revision、耗时和 Trace ID，不能记录密钥、完整问题、文档正文或供应商原始响应。
- Embedding 必须保证每个 itemId 只返回一次、向量数量和维度准确；Reranker 只能返回输入候选；OCR 只能返回请求过的 targetId。

### 5.3 联调时怎么抓问题

先看 Provider 配置是否真的被进程读取，再看调用错误：

```powershell
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 300 ingestion-worker | Select-String 'EMBEDDING|OCR|SCHEMA|VERSION|TIMEOUT'
docker compose --env-file images.env --env-file .env -f docker-compose.yml logs --tail 300 rag-query-service | Select-String 'LLM|RERANK|SCHEMA|VERSION|TIMEOUT'
```

Linux 把 `Select-String` 换成 `grep -E`。然后按 `provider-http-contracts.md` 分别请求服务：

- Embedding 先看 `/metadata`，重点对比模型 ID、revision、denseDimension、normalizeDense、Tokenizer revision。
- Reranker 传三个有明确强弱关系的候选，检查返回数量、candidateId 和顺序。
- OCR 用一页扫描 PDF，检查页码、targetId、bbox、置信度和引擎 revision。
- LLM 要测试正常回答、无证据拒答、冲突证据和严格 JSON；能聊天不等于能稳定生成本项目结构。

## 6. 本地源码运行

源码运行不是在 `rag-intranet-release` 目录里凭空启动代码。必须把完整仓库带入内网，并同时带上
外网准备好的隐藏目录 `.offline/pnpm-store`。内网机器需要 Node 22.20+、pnpm 11.19+；不需要 npm 网络。

以 Windows 的 `D:\coding\rag` 为例，先确认：

```powershell
node --version
pnpm --version
Test-Path D:\coding\rag\.offline\pnpm-store
```

返回的 Node/pnpm 版本正确且最后一行是 `True` 后，复制配置并启动：

```powershell
Set-Location D:\coding\rag\rag-intranet-release
Copy-Item .env.example .env
notepad .env
.\local-run.ps1
```

Linux：

```bash
cd /data/rag/rag-intranet-release
cp .env.example .env
vi .env
chmod +x ./*.sh
./local-run.sh
```

脚本会：

1. 把 `.env` 复制为仓库根目录 `.env.external-dev`；
2. 强制执行 `pnpm install --offline --store-dir .offline/pnpm-store`，不会访问公网；
3. 把 Parser 临时目录放在仓库 `.data/parser-runtime`，不会主动写 C 盘运行数据；
4. 执行数据库迁移、按需建桶和 PG/Redis/MinIO/Milvus 深度检查；
5. 启动六个开发进程。

若 `.env.external-dev` 已存在，脚本为避免覆盖密钥会拒绝。Windows 确认后使用
`.\local-run.ps1 -ForceProfile`；Linux 使用 `FORCE_PROFILE=true ./local-run.sh`。停止时按 `Ctrl+C`。

本地端口：Platform 3000、Query 3001、Ingestion Probe 3002、Scheduler Probe 3003、Parser 8104、Web 5173。不要执行 `pnpm dev:infra`、`pnpm dev:all` 或 `pnpm dev:docker`，它们会启动仓库自带基础设施，与现有内网服务冲突。

源码方式下，`.env` 里的 PG、Redis、MinIO、Milvus、LLM、Embedding、Reranker、OCR 地址必须是
Windows/Linux 主机自己能访问的地址；Docker 方式下，这些地址必须是容器网络能访问的地址。
不要在 Docker 的 `.env` 里写 `127.0.0.1` 指向宿主机服务，因为容器中的 127.0.0.1 是容器自己。

## 7. 从 Mock 鉴权切到企业鉴权

当前联调三元组必须保持成套：

```dotenv
APP_ENV=development
PROVIDER_PROFILE=external-dev
AUTH_MODE=mock
```

正式上线不能只把 `APP_ENV` 改成 production；配置层会拒绝不匹配组合。推荐由企业反向代理完成登录并签入可信用户头，再切为：

```dotenv
APP_ENV=production
PROVIDER_PROFILE=intranet-production
AUTH_MODE=trusted-header
```

同时按 `.env.intranet-production.example` 补齐可信代理 CIDR、请求签名密钥、时间戳和用户/角色 Header 配置。另一种选择是 `AUTH_MODE=jwt`，配置企业 Issuer、Audience、JWKS URI 和角色映射。无论哪种，都只接受 `user_id + roles`，领域权限模型不用重写。

生产 Profile 还会强制 TLS、非默认密钥、Sparse 能力等更严格规则。因此应先确认内网实际能力再切；如果 Embedding 只有 Dense，需要先通过 ADR 调整生产基线，不能靠伪造 Sparse 元数据绕过。

## 8. 验收顺序

1. `verify`：制品完整；
2. `load-images`：六个 Tag 都能 inspect；
3. `preflight`：配置和 PG/Redis/MinIO/Milvus 全绿；
4. `start`：Bootstrap `Exited (0)`，六个应用健康；
5. 上传一个公开 TXT 和一个扫描 PDF，确认真实解析/OCR/进度事件；
6. 确认 Embedding 写入 Milvus并发布活动索引；
7. 发起真实问题，检查 Reranker、GLM、引用定位、拒答与 SSE；
8. 重启 Worker，确认 BullMQ 任务没有丢失且幂等恢复；
9. 最后切企业鉴权，再做越权、角色映射和审计验收。
