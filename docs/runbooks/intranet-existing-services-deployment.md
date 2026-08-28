# 内网部署手册：使用现有内网服务部署 RAG 应用

本手册面向内网管理员。前提：PostgreSQL、一个物理 Redis、MinIO、Milvus、PaddleOCR、BGE-M3 Embedding、BGE Reranker、OpenAI-compatible LLM 均已部署好，直接填地址。本方案**只部署 6 个应用镜像**，不重复部署任何基础设施或模型服务。

发布包由 `scripts/build-intranet-app-release.ps1` 在外网制品机生成，结构：

```text
enterprise-rag-intranet-apps-<version>-<short-sha>/
├── images/enterprise-rag-apps-<version>-<short-sha>.tar
├── docker-compose.yml
├── images.env              # 已含实际镜像 tag
├── runtime.env.example     # 复制为 runtime.env 后填写
├── README.md
├── IMAGE-MANIFEST.json
├── VERSION
└── SHA256SUMS
```

> 仓库内对应文件位于 `intranet/` 目录（与方案文档 `deploy/intranet-existing/` 一一对应）。

## 一、前置清单

部署前必须确认：

- **Docker**：Engine ≥ 24.0，含 Compose Plugin（`docker compose version`）。
- **宿主机架构与资源**：确认 CPU 架构与构建时 `-Platform` 一致（默认 linux/amd64）；可用内存建议 ≥ 8 GiB。
- **DNS 与连通性**：6 个应用容器到 PG、Redis、MinIO、Milvus 和全部模型服务的 DNS 解析、路由、端口、TLS 证书连通性。
- **浏览器到 MinIO**：浏览器能访问 MinIO 预签名上传 URL（`MINIO_ENDPOINT` 的 Host 必须浏览器可解析）。
- **Parser/OCR 到 MinIO**：能访问 MinIO 预签名下载地址。
- **PostgreSQL**：数据库、用户、备份策略已就绪；`pgcrypto` 扩展已启用；迁移账号在目标 schema 拥有 DDL 与 advisory lock 权限。
- **Redis**：确认是 Standalone/Sentinel/Cluster；支持多逻辑 DB；BullMQ 使用的 DB 为 `noeviction`。
- **MinIO**：Bucket 与 CORS 已配置（见第四节）。
- **认证**：企业认证网关（trusted-header）或 JWT 配置就绪。
- **NTP**：宿主机与容器时间同步（影响签名时间窗、Token、审计）。
- **Provider 契约**：OCR、Embedding、Reranker、LLM 符合 `docs/contracts/provider-http-contracts.md`，不只是“地址能通”。

### PostgreSQL 一次性检查

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

当前代码只支持一个 `DATABASE_URL`，迁移与运行共用同一账号。手册明确：在迁移窗口内使用有 DDL 权限的账号执行 `migrate`，迁移完成后可收敛为最小权限运行账号；若无法分离，至少保证运行账号具备 advisory lock 与目标表的读写权限。

### Redis 检查（不显示密码）

```bash
# 假设已通过受控方式登录 redis-cli
PING
INFO server
CONFIG GET databases
CONFIG GET maxmemory-policy
```

要点：
- 确认 `databases ≥ 2`，可使用 `/0`（Cache）与 `/1`（BullMQ）。
- BullMQ 的 DB 必须 `maxmemory-policy noeviction`，否则队列键、锁、重试状态会被静默淘汰。
- 若为 Redis Cluster，通常只能用 DB 0，不能仅靠 ENV 隔离 Cache 与 BullMQ——需改 Adapter 或申请独立实例。

## 二、导入与验签

```bash
cd enterprise-rag-intranet-apps-<version>-<short-sha>/

# 校验完整性（SHA256SUMS 覆盖 tar 与全部交付文件）
sha256sum -c SHA256SUMS

# 导入 6 个应用镜像
docker load --input images/enterprise-rag-apps-<version>-<short-sha>.tar

# 确认 6 个镜像都在，且不含 PG/Redis/MinIO/Milvus/etcd/模型镜像
docker image ls | grep enterprise-rag
```

Windows PowerShell 验签：

```powershell
# 逐行比对 SHA256SUMS
Get-Content SHA256SUMS | ForEach-Object {
  $parts = $_ -split '\s+', 2
  $expected = $parts[0].ToLower()
  $file = $parts[1]
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "校验失败：$file" }
}
docker load --input images/enterprise-rag-apps-<version>-<short-sha>.tar
```

若内网使用私有 Registry，追加：`docker load` → `docker tag` → 漏洞扫描 → `docker push` → 用 digest 更新 `images.env`（把 `enterprise-rag/<app>:<tag>` 换成 `<registry>/rag/<app>@sha256:...`）。

## 三、填写配置

```bash
cp runtime.env.example runtime.env
chmod 600 runtime.env
```

编辑 `runtime.env`，替换所有 `<...>` 占位符。**占位符检查命令**（生产启动前不得残留）：

```bash
# 列出仍含 <...> 的行（不应有输出）
grep -nE '<[a-z-]+>' runtime.env || echo '占位符已全部清零'
```

```powershell
# Windows
Select-String -Path runtime.env -Pattern '<[a-z-]+>' | Format-Table
```

不能用 `.example` 直接启动生产。密钥由 Secret 管理系统或受控文件在运行时注入，不写进镜像、Git、构建日志或 `images.env`。

### 生成 RUN_CONTENT_ENCRYPTION_KEY

```powershell
$KeyBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($KeyBytes)
[Convert]::ToBase64String($KeyBytes)
```

已写入数据库的加密内容依赖该密钥，重启和升级必须保持可用，不能随意重生成。

## 四、MinIO Bucket 与 CORS

`storage-init`（`scripts/seed-storage.ts`）幂等创建以下 4 个 Bucket：

```text
rag-quarantine
rag-derived
rag-documents
rag-artifacts
```

若应用 MinIO 账号没有 `makeBucket` 权限，请管理员预先创建上述 4 个 Bucket，再以最小权限账号运行应用。MinIO CORS 必须允许 Web Console 的正式 Origin（`CORS_ALLOWED_ORIGINS`）。

## 五、校验、迁移、建桶、启动

```bash
export RAG_ENV_FILE="$(pwd)/runtime.env"

# 1. 校验 ENV 与 Compose
docker compose \
  --env-file images.env \
  -f docker-compose.yml \
  config --quiet

# 2. 运行数据库迁移
docker compose \
  --env-file images.env \
  -f docker-compose.yml \
  run --rm migrate

# 3. 运行 MinIO Bucket 初始化（一次性，--profile init）
docker compose \
  --env-file images.env \
  -f docker-compose.yml \
  --profile init run --rm storage-init

# 4. 启动 6 个应用
docker compose \
  --env-file images.env \
  -f docker-compose.yml \
  up -d

# 5. 查看状态
docker compose \
  --env-file images.env \
  -f docker-compose.yml \
  ps
```

> `RAG_ENV_FILE` 通过 shell 导出在跨 `sudo` 时可能丢失。若需 sudo 运行 docker，改用绝对路径显式传值：`RAG_ENV_FILE=/abs/path/runtime.env`，或用 `--env-file runtime.env` 额外注入。

Windows PowerShell：

```powershell
$env:RAG_ENV_FILE = "$(Get-Location)\runtime.env"
docker compose --env-file images.env -f docker-compose.yml config --quiet
docker compose --env-file images.env -f docker-compose.yml run --rm migrate
docker compose --env-file images.env -f docker-compose.yml --profile init run --rm storage-init
docker compose --env-file images.env -f docker-compose.yml up -d
docker compose --env-file images.env -f docker-compose.yml ps
```

## 六、验收与运维

### 健康检查

| 服务 | 检查 |
|---|---|
| Web Console | `http://<host>:8080/` |
| Platform API | 容器内 `http://platform-api:3000/v1/health/ready`（不对外发布） |
| RAG Query Service | 容器内 `http://rag-query-service:3001/v1/health/ready` |
| Ingestion Worker 探针 | 容器内 `http://ingestion-worker:3002/v1/health/ready` |
| Scheduler Worker 探针 | 容器内 `http://scheduler-worker:3003/v1/health/ready` |
| Parser | 容器内 `http://document-parser-service:8104/v1/health/ready` |

> 后端端口默认不映射到宿主机。如运维确需探针，用 `docker compose exec` 或临时 override 仅绑定 `127.0.0.1`，**不能把 trusted-header API 暴露给普通内网用户**。

### 日志

```bash
docker compose --env-file images.env -f docker-compose.yml logs --tail 100
docker compose --env-file images.env -f docker-compose.yml logs -f platform-api
```

日志采用 json-file 轮转（单文件 50 MiB，保留 5 份）。

### 停止、重启、滚动升级、回滚

```bash
# 正常停止（不删数据）
docker compose --env-file images.env -f docker-compose.yml down

# 重启单服务
docker compose --env-file images.env -f docker-compose.yml restart platform-api

# 滚动升级：先备份 PG，再迁移，再切换镜像
docker compose --env-file images.env -f docker-compose.yml run --rm migrate
docker compose --env-file images.env -f docker-compose.yml up -d platform-api
```

升级前必须备份 PostgreSQL。先迁移再切换应用镜像。回滚时区分：
- **仅应用回滚**：`docker tag` 回旧镜像，更新 `images.env`，`up -d`。
- **数据库 migration 不可逆**：不能仅靠应用回滚撤销 DDL；需用备份恢复或补一个反向 migration。

### 密钥轮换

`RUN_CONTENT_ENCRYPTION_KEY` 轮换需先解密存量内容再用新密钥重写，不能直接替换否则历史正文不可读。轮换前备份并验证。

### 监控项

- Redis 内存与队列积压（BullMQ DB）；
- PG 连接数、慢查询、磁盘；
- MinIO 磁盘与请求 4xx/5xx；
- Milvus 延迟与错误率；
- Provider 429/5xx；
- 容器 CPU/内存/重启次数；
- 磁盘剩余空间。

### 常见问题

- 容器内不能用 `localhost` 访问外部服务，必须用内网 FQDN。
- 内部 CA 不受信：把 CA 证书加入镜像信任链，**不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- MinIO CORS：预签名上传被浏览器拒绝。
- 预签名地址不可达：`MINIO_ENDPOINT` 的 Host 浏览器解析不了。
- Embedding 元数据不匹配：`/metadata` 返回的 dimension/revision/sparseFormatVersion 与 env 不一致，平台 fail-closed。
- Redis Cluster 不支持 DB 1：BullMQ 写入失败或串键。
- trusted-header 被拒绝：`AUTH_TRUSTED_PROXY_CIDRS` 没包含网关出口 CIDR。

### 最低端到端验收

1. 浏览器能打开 Web Console。
2. 认证身份与角色正确。
3. 创建知识空间。
4. 上传一个小 TXT 和一个包含中文的 PDF。
5. 上传、解析、OCR（如触发）、Chunk、Embedding、Milvus 发布全部完成。
6. 提问并得到带引用答案。
7. 引用可以定位到正确文档位置。
8. SSE 断线重连和 Run 状态查询正常。
9. 容器重启后数据不丢失（事实数据都在外部 PG/MinIO/Redis/Milvus）。
10. 日志中没有密钥、完整问题正文或文档正文。

## 七、Provider 契约验证

不能只验证“地址能通”。按 `docs/contracts/provider-http-contracts.md` 验证：

| Provider | 项目要求 |
|---|---|
| LLM | `POST {LLM_BASE_URL}/chat/completions`，返回 OpenAI-compatible `choices[].message.content`，结构化任务能稳定返回合法 JSON |
| Embedding | `GET /health`、`GET /metadata`、`POST /v1/embeddings`；元数据、维度、revision、dense/sparse 必须匹配 |
| Reranker | `GET /health`、`GET /v1/metadata`、`POST /v1/rerank`；返回 candidateId、score、rank |
| OCR | `POST /v1/ocr`，协议版本 2，返回项目定义的 blocks、targetId、置信度和坐标 |

若内网 PaddleOCR、Embedding 或 Reranker 只是供应商原生接口、与仓库契约不一致，**仅填 ENV 不会自动兼容**。此时应在 `libs/adapters-*` 既有 Port/Adapter 边界内增加薄 Adapter/Facade 并补契约测试，不要在业务 Service 中写临时转换逻辑。这属于独立后续任务，不在本次部署范围内。
