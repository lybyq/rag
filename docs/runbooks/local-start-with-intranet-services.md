# 本地源码启动手册：连接现有内网服务

本手册面向开发者。在本地用源码运行 5 个后端进程和 Web Console，PostgreSQL、Redis、MinIO、Milvus、PaddleOCR、Embedding、Reranker、LLM 全部连接已部署好的内网地址。**本地不启动仓库自带的 PG/Redis/MinIO/Milvus。**

## 一、本地实际运行什么

```text
platform-api              3000
rag-query-service         3001
ingestion-worker          3002（探针）
scheduler-worker          3003（探针）
document-parser-service   8104
web-console               5173
```

本地不运行：PG、Redis、MinIO、Milvus、PaddleOCR、Embedding、Reranker、LLM。

## 二、环境要求

- Git；
- Node.js `>=22.20.0`；
- pnpm `>=11.19.0`，优先通过 Corepack 使用仓库锁定的 `pnpm@11.19.0`；
- 本机能解析并访问全部内网域名；
- 内网 HTTPS 若用自签 CA，使用受控 CA 信任方案（导入根证书），**不得**用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过；
- 连接现有内网资源时不要求 Docker；只有构建镜像时才要求 Docker。

## 三、准备本地 ENV

不要直接使用可能缺字段的 `.env.external-dev.example`。从 `.env.example` 复制后覆盖外部地址：

```powershell
Copy-Item .env.example .env.external-dev
```

```bash
cp .env.example .env.external-dev
```

编辑 `.env.external-dev`，关键项：

```dotenv
APP_ENV=development
PROVIDER_PROFILE=external-dev
AUTH_MODE=mock
AUTH_MOCK_PRESET_ID=dev-admin

DATABASE_URL=postgresql://<dev-user>:<password>@<pg-host>:5432/<dev-database>?sslmode=require
REDIS_CACHE_URL=redis://<user>:<password>@<redis-host>:6379/0
REDIS_BULLMQ_URL=redis://<user>:<password>@<redis-host>:6379/1
MINIO_ENDPOINT=https://<minio-host>:<port>
MINIO_ACCESS_KEY=<dev-access-key>
MINIO_SECRET_KEY=<dev-secret-key>

PARSER_ADAPTER=http
PARSER_BASE_URL=http://127.0.0.1:8104
PARSER_TEMP_ROOT=.data/parser-runtime
PARSER_ALLOWED_SOURCE_HOSTS=<minio-host-only>

OCR_ADAPTER=http
OCR_BASE_URL=http://<paddleocr-host>:<port>
OCR_PROTOCOL_VERSION=2

LLM_ADAPTER=openai-compatible
LLM_BASE_URL=http://<llm-host>:<port>/v1

EMBEDDING_ADAPTER=http
EMBEDDING_BASE_URL=http://<embedding-host>:<port>
EMBEDDING_OUTPUT_MODE=dense,sparse

RERANKER_ADAPTER=http
RERANKER_BASE_URL=http://<reranker-host>:<port>

VECTOR_STORE_ADAPTER=milvus
MILVUS_ADDRESS=<milvus-host>:19530

CORS_ALLOWED_ORIGINS=http://localhost:5173
```

其余 revision、ID、Token、超时和资源限制必须继续从 `.env.example` 完整填写，不能省略关键配置。Embedding/Reranker/LLM/OCR 的 revision、modelId、profileId 必须与内网实际部署一致。

> `AUTH_MODE=mock` 只允许个人开发环境。若要在本地复现生产认证：
> - 用 `intranet-staging`/`intranet-production` + JWT；或
> - 经过企业网关转发的 trusted-header 方式。
>
> 不要从浏览器直接伪造 trusted header 冒充生产验收。

## 四、首次启动

Windows PowerShell：

```powershell
git fetch origin main
git switch main
git pull --ff-only origin main
corepack enable
pnpm install --frozen-lockfile

$env:PROVIDER_PROFILE = 'external-dev'
pnpm db:migrate
pnpm exec tsx scripts/seed-storage.ts
pnpm health:deep
pnpm dev:services
```

Linux/macOS：

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
corepack enable
pnpm install --frozen-lockfile

export PROVIDER_PROFILE=external-dev
pnpm db:migrate
pnpm exec tsx scripts/seed-storage.ts
pnpm health:deep
pnpm dev:services
```

> 若当前工作区有修改，不要盲目 `git switch` 或 `git pull` 覆盖；先决定使用哪个 commit/工作树。

## 五、禁止执行的命令

连接现有内网资源时，**不要执行**下面这些会启动仓库自带基础设施的命令：

```text
pnpm dev:infra
pnpm dev:all
pnpm dev:docker
```

这些命令会拉起容器版 PG/Redis/MinIO/Milvus，与“连接现有内网服务”的目标冲突，且会占用本地端口。

## 六、数据隔离

本地开发不能直接写生产数据库、生产 Bucket、生产 Redis DB 或生产 Milvus collection。至少使用以下任一方案：

- 独立开发环境地址；
- 同一集群中的独立数据库/schema、Redis DB、Bucket 前缀和 Milvus database/collection 前缀；
- 由内网平台提供的个人开发租户。

即使网络能连通，也不代表允许拿生产资源做本地迁移和调试。特别提醒：`pnpm db:migrate`、`seed-storage.ts` 和上传/索引都会产生真实写操作。

## 七、本地排错

- **端口占用**：3000/3001/3002/3003/5173/8104 被占用。用 `netstat -ano | findstr :3000`（Windows）或 `lsof -i:3000`（Linux）排查并释放。
- **ENV 未加载 / PROVIDER_PROFILE 写错**：确认 `.env.external-dev` 存在且 `PROVIDER_PROFILE=external-dev`；`dev:*` 脚本默认读该文件。
- **容器地址与本机地址混淆**：容器内服务名（如 `minio`）在本地不可用，必须用内网 FQDN。
- **内网 DNS/VPN/防火墙**：本机无法解析内网域名或端口不通。
- **PG pgcrypto 与 migration 权限**：`CREATE EXTENSION IF NOT EXISTS pgcrypto;`，迁移账号需 DDL + advisory lock 权限。
- **Redis DB 1 不可用或 eviction policy 错误**：确认 Redis 支持 ≥2 个 DB，BullMQ 的 DB 为 `noeviction`；Cluster 只能用 DB 0。
- **MinIO CORS / Bucket 不存在 / 预签名地址浏览器不可达**：`MINIO_ENDPOINT` 的 Host 浏览器必须可解析；CORS 允许 `http://localhost:5173`；4 个 Bucket 已建。
- **OCR/Embedding/Reranker 契约不匹配**：按 `docs/contracts/provider-http-contracts.md` 验证，不只是地址能通。
- **BGE-M3 只返回 Dense、没有 Sparse**：`EMBEDDING_OUTPUT_MODE=dense,sparse`，且 `EMBEDDING_SPARSE_FORMAT_VERSION` 必须同时配置，否则配置校验失败。
- **Milvus dimension/profile/revision 与 Manifest 不一致**：`/metadata` 返回值与 env 必须一致，平台 fail-closed。
- **LLM 不能稳定返回 JSON**：结构化任务要求合法 JSON，模型网关不能追加解释或 Markdown fence。
- **Parser 临时目录权限和磁盘空间**：`PARSER_TEMP_ROOT=.data/parser-runtime`，确保本机该路径可写且有空间。
