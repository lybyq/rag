# RAG 应用镜像内网部署包

本目录是“使用现有内网服务”的独立部署路径，与 `deploy/airgap/`（连 PG/Redis/MinIO/Milvus 也打包）互不干扰。

## 适用场景

内网已自建 PostgreSQL、一个 Redis、MinIO、Milvus 和全部模型服务（PaddleOCR、BGE-M3 Embedding、BGE Reranker、OpenAI-compatible LLM），只部署 6 个本项目应用镜像。

## 文件说明

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 编排 6 个应用 + `migrate` + `storage-init`，不含任何基础设施 |
| `runtime.env.example` | 完整生产 ENV 模板，复制为 `runtime.env` 后填写 |
| `images.env.example` | 6 个应用镜像 tag 变量，复制为 `images.env` |

## 与方案文档的对应关系

方案（`deploy/intranet-existing/`）→ 本目录：

| 方案路径 | 本仓库路径 |
|---|---|
| `deploy/intranet-existing/docker-compose.yml` | `intranet/docker-compose.yml` |
| `deploy/intranet-existing/runtime.env.example` | `intranet/runtime.env.example` |
| `deploy/intranet-existing/images.env.example` | `intranet/images.env.example` |
| `deploy/intranet-existing/README.md` | `intranet/README.md`（本文件） |
| `scripts/build-intranet-app-release.ps1` | `scripts/build-intranet-app-release.ps1` |
| `docs/runbooks/intranet-existing-services-deployment.md` | `docs/runbooks/intranet-existing-services-deployment.md` |
| `docs/runbooks/local-start-with-intranet-services.md` | `docs/runbooks/local-start-with-intranet-services.md` |

## 在外网制品机构建镜像

```powershell
git fetch origin main
git switch main
git pull --ff-only origin main
corepack enable
pnpm install --frozen-lockfile
pnpm check
./scripts/build-intranet-app-release.ps1 -Version 0.1.0 -Platform linux/amd64 -OutputRoot D:/rag-release
Get-FileHash D:/rag-release/enterprise-rag-intranet-apps-*/images/*.tar -Algorithm SHA256
```

脚本产出 `enterprise-rag-intranet-apps-<version>-<short-sha>/` 目录，含 `images/*.tar`（6 个应用镜像）、`docker-compose.yml`、`images.env`、`runtime.env.example`、`README.md`、`IMAGE-MANIFEST.json`、`VERSION`、`SHA256SUMS`。tar 只含 6 个应用镜像，不含 PG/Redis/MinIO/Milvus/etcd/模型镜像。

## 在内网部署

完整可照抄步骤见 `docs/runbooks/intranet-existing-services-deployment.md`。最短路径：

```bash
cd enterprise-rag-intranet-apps-<version>-<short-sha>/
sha256sum -c SHA256SUMS
docker load --input images/enterprise-rag-apps-<version>-<short-sha>.tar

cp runtime.env.example runtime.env
chmod 600 runtime.env
# 编辑 runtime.env，替换所有 <...> 占位符

export RAG_ENV_FILE="$(pwd)/runtime.env"
docker compose --env-file images.env -f docker-compose.yml config --quiet
docker compose --env-file images.env -f docker-compose.yml run --rm migrate
docker compose --env-file images.env -f docker-compose.yml --profile init run --rm storage-init
docker compose --env-file images.env -f docker-compose.yml up -d
docker compose --env-file images.env -f docker-compose.yml ps
```

## 上线前必须确认

1. 一个 Redis 是否支持 `/0`、`/1` 逻辑库，且 BullMQ 的 DB 使用 `noeviction`；
2. PostgreSQL 是否有 `pgcrypto` 和 migration 权限；
3. OCR、Embedding、Reranker 是否符合 `docs/contracts/provider-http-contracts.md` 契约（不只是供应商原生接口）；
4. 生产认证使用可信网关或 JWT，后端端口不被绕过网关直连。

本地源码启动方式见 `docs/runbooks/local-start-with-intranet-services.md`。
