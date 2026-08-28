# RAG 内网测试发布包（external-dev + Mock Auth）

本目录是把 6 个应用镜像带入内网、连接已部署的 PostgreSQL/Redis/MinIO/Milvus/PaddleOCR/Embedding/
Reranker/LLM 做联调验证的**独立发布包**。鉴权使用项目自带 Mock Auth（内网暂无统一认证服务），
**仅用于内网测试，不可用于生产**。

## 目录文件

| 文件 | 作用 |
|---|---|
| `build-release.ps1` | 外网制品机构建 6 镜像并导出 `rag-apps.tar`（生成本目录的 tar） |
| `docker-compose.yml` | 内网编排：6 应用 + 1 个 bootstrap（迁移+建桶），不含基础设施 |
| `.env.example` | 完整 ENV 模板（external-dev + mock），复制为 `.env` 后填写 |
| `start.sh` / `start.ps1` | 内网一键启动（校验→load→config→up→ps→打印地址） |
| `rag-apps.tar` | 6 个应用镜像归档（由 build-release.ps1 生成，不入 Git） |
| `IMAGE-MANIFEST.json` / `VERSION` / `SHA256SUMS` | 构建元数据与校验和 |

镜像 tag 固定为 `enterprise-rag/<app>:0.1.0-dev`（禁止 latest）：

| 应用 | 镜像 |
|---|---|
| platform-api | `enterprise-rag/platform-api:0.1.0-dev` |
| rag-query-service | `enterprise-rag/rag-query-service:0.1.0-dev` |
| ingestion-worker | `enterprise-rag/ingestion-worker:0.1.0-dev` |
| scheduler-worker | `enterprise-rag/scheduler-worker:0.1.0-dev` |
| document-parser-service | `enterprise-rag/document-parser-service:0.1.0-dev` |
| web-console | `enterprise-rag/web-console:0.1.0-dev` |

不打包：PostgreSQL、Redis、MinIO、Milvus、PaddleOCR、Embedding、Reranker、LLM。

## 一、在外网制品机构建镜像

```powershell
git fetch origin main
git switch main
git pull --ff-only origin main
corepack enable
pnpm install --frozen-lockfile
./rag-intranet-release/build-release.ps1
# 内网为 ARM64 时：./rag-intranet-release/build-release.ps1 -Platform linux/arm64
```

脚本默认执行 `pnpm install --frozen-lockfile` + `pnpm build`，构建 6 镜像，`docker save` 为
`rag-apps.tar`，并生成 `IMAGE-MANIFEST.json` / `VERSION` / `SHA256SUMS`。脏工作区默认拒绝
（`-AllowDirty` 放行但 manifest 标记 dirty）。

校验：

```powershell
pnpm build
pnpm docker:check
docker compose -f rag-intranet-release/docker-compose.yml config -q
Get-FileHash rag-intranet-release/rag-apps.tar -Algorithm SHA256
```

## 二、在内网部署

把整个 `rag-intranet-release/` 目录拷入内网服务器，在该目录内执行：

```bash
docker load -i rag-apps.tar
cp .env.example .env
# 编辑 .env，替换所有 <...> 占位符为真实内网地址
./start.sh          # Linux/macOS/Git Bash
# 或 PowerShell：.\start.ps1
```

`start` 脚本依次：检查 `.env` → 扫描占位符 → `docker load` → `docker compose config` →
`docker compose up -d` → `docker compose ps` → 打印访问地址。

`up -d` 时 **bootstrap** 服务会自动执行：

```
pnpm db:migrate          # 等价 ./node_modules/.bin/tsx scripts/migrate.ts
pnpm exec tsx scripts/seed-storage.ts   # 幂等创建 MinIO Bucket
```

6 个应用 `depends_on: bootstrap (service_completed_successfully)`，迁移与建桶成功后才会启动。
仅 Web Console 暴露 `8080`；其余服务仅在内部网络 `rag-net` 可达。Web Console 同源代理：
`/api/v1/(conversations|runs|run-streams|citations)` → `rag-query-service:3001`，
其余 `/api/` → `platform-api:3000`。

访问：`http://<服务器IP>:8080`

### 必填 ENV（占位符项，否则 start 脚本拒绝启动）

| 类别 | 变量 |
|---|---|
| PostgreSQL | `DATABASE_URL` |
| Redis | `REDIS_CACHE_URL`、`REDIS_BULLMQ_URL`（同一实例 `/0`、`/1`） |
| MinIO | `MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`PARSER_ALLOWED_SOURCE_HOSTS`、`CORS_ALLOWED_ORIGINS` |
| OCR | `OCR_BASE_URL`、`OCR_MODEL_ID`、`OCR_REVISION` |
| LLM | `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL_ID`、`LLM_REVISION` |
| Embedding | `EMBEDDING_BASE_URL`、`EMBEDDING_PROVIDER_NAME`、`EMBEDDING_REVISION`、`EMBEDDING_TOKENIZER_REVISION` |
| Reranker | `RERANKER_BASE_URL`、`RERANKER_REVISION` |
| Milvus | `MILVUS_ADDRESS` |

`RUN_CONTENT_ENCRYPTION_KEY` 已给默认测试值（development 不校验）；若内网已写入加密内容须保持不变，
否则可生成 Base64 的 32 字节随机密钥替换。其余 revision/profileId/超时等字段已在模板给默认值，
按内网实际服务版本修订即可。

### 启动后验证

```bash
docker compose ps                           # 6 应用 + bootstrap 应 Exited(0)
docker compose logs bootstrap               # 看迁移与建桶是否成功
curl http://127.0.0.1:8080/api/v1/health/ready   # 经 Web Console 代理到 platform-api
```

功能验证：Web Console 上传 TXT/PDF → 触发接入 → Embedding 写入 Milvus → 检索 + Reranker → LLM 回答。
Mock 鉴权下默认身份为 `dev-admin`（`SYSTEM_ADMIN`），无需登录即可操作。

## 三、本地源码启动（连接同样内网资源）

在仓库根目录用源码跑 5 个后端进程 + Web Console，外部资源全部指向内网，**不**启动仓库自带基础设施。

### 1. 准备本地 ENV

```powershell
Copy-Item .env.example .env.external-dev      # bash: cp .env.example .env.external-dev
```

编辑 `.env.external-dev`，关键项：

```dotenv
APP_ENV=development
PROVIDER_PROFILE=external-dev
AUTH_MODE=mock

DATABASE_URL=postgresql://<user>:<password>@<pg-host>:5432/<database>
REDIS_CACHE_URL=redis://<user>:<password>@<redis-host>:6379/0
REDIS_BULLMQ_URL=redis://<user>:<password>@<redis-host>:6379/1
MINIO_ENDPOINT=http://<minio-host>:<port>
MINIO_ACCESS_KEY=<填写>
MINIO_SECRET_KEY=<填写>

PARSER_ADAPTER=http
PARSER_BASE_URL=http://127.0.0.1:8104        # 本地源码跑 parser
PARSER_TEMP_ROOT=.data/parser-runtime        # 本地相对路径
PARSER_ALLOWED_SOURCE_HOSTS=<minio-host-only>

OCR_ADAPTER=http
OCR_BASE_URL=http://<paddleocr-host>:<port>
LLM_ADAPTER=openai-compatible
LLM_BASE_URL=http://<llm-host>:<port>/v1
EMBEDDING_ADAPTER=http
EMBEDDING_BASE_URL=http://<embedding-host>:<port>
EMBEDDING_OUTPUT_MODE=dense,sparse
RERANKER_ADAPTER=http
RERANKER_BASE_URL=http://<reranker-host>:<port>
VECTOR_STORE_ADAPTER=milvus
MILVUS_ADDRESS=<milvus-host>:19530
```

PG、Redis、MinIO、Milvus、OCR、Embedding、Reranker、LLM 全部填内网地址。

### 2. 启动命令

```powershell
corepack enable
pnpm install --frozen-lockfile

$env:PROVIDER_PROFILE='external-dev'
pnpm db:migrate
pnpm exec tsx scripts/seed-storage.ts
pnpm health:deep
pnpm dev:services
```

`pnpm dev:services` 会并发启动 platform-api(3000)、rag-query-service(3001)、
ingestion-worker(3002探针)、scheduler-worker(3003探针)、document-parser-service(8104)、
web-console(5173)。

### 3. 禁止执行的命令

不要执行以下命令，它们会启动仓库自带的基础设施（PG/Redis/MinIO/Milvus 等），与“连接现有内网服务”冲突：

- `pnpm dev:infra`
- `pnpm dev:all`
- `pnpm dev:docker`

## 四、安全说明

- Mock Auth 仅用于内网测试。`libs/config/src/app-config.ts` 中 **生产环境禁止 Mock** 的安全校验
  **保留未动**；本包靠 `PROVIDER_PROFILE=external-dev` + `APP_ENV=development` 绕过该限制，正式生产
  须切回 `intranet-production` + `trusted-header`（见仓库 `intranet/` 目录）。
- `.env` 含真实密码，禁止提交 Git（已由 `.gitignore` 忽略 `rag-intranet-release/.env` 与 `rag-apps.tar`）。
- 镜像不含任何真实密码；所有密钥在运行时由 `.env` 注入。
