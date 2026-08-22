# M00～M03 本地开发与故障排查

## 1. 前置条件

- Node.js `22.20.0+`
- pnpm `11.19.0+`
- Docker Desktop / Docker Engine `29+`，Compose `2.40+`
- 建议至少 8 GB 可用内存；Milvus 启动明显慢于 PostgreSQL/Redis。

## 2. 首次启动

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm dev:infra
pnpm db:migrate
pnpm health:deep
pnpm seed:dev
pnpm dev:services
```

如果系统盘空间紧张，先把 pnpm Store、临时目录和 Parser 临时根放到数据盘。本项目当前开发机使用：

```powershell
pnpm config set store-dir D:\.pnpm-store
New-Item -ItemType Directory -Force D:\codex-temp\rag-m03
$env:TEMP='D:\codex-temp\rag-m03'
$env:TMP='D:\codex-temp\rag-m03'
$env:PARSER_TEMP_ROOT='D:\coding\rag\.data\parser-runtime'
```

不要在未确认 Docker `data-root` 所在磁盘前拉取 Docling CPU 镜像；它明显大于普通基础设施镜像。本轮只做了 Compose 静态校验，没有在 C 盘空间为 0 的机器上拉取它。

也可运行 `pnpm dev:all`，它依次启动基础设施、等待并迁移 PostgreSQL、创建开发 Bucket，再并行启动核心后端、Node Parser Service 和 Web。

## 3. 入口

| 服务                  | 地址                                       |
| --------------------- | ------------------------------------------ |
| Web Console           | `http://localhost:5173`                    |
| Platform API liveness | `http://localhost:3000/api/v1/health/live` |
| 当前身份              | `http://localhost:3000/api/v1/auth/me`     |
| 知识空间 API          | `http://localhost:3000/api/v1/spaces`      |
| Query API liveness    | `http://localhost:3001/api/v1/health/live` |
| Ingestion probe       | `http://localhost:3002/api/v1/health/live` |
| Scheduler probe       | `http://localhost:3003/api/v1/health/live` |
| Node Parser readiness | `http://localhost:8104/v1/health/ready`    |
| MinIO Console         | `http://localhost:9001`                    |
| 文档接入与任务中心    | `http://localhost:5173/tasks`              |

`/health/live` 只看进程；`/health/ready` 会真实访问 PostgreSQL、两个 Redis、MinIO 和 Milvus；`/metrics` 输出 Prometheus 指标。

## 4. 日常命令

```powershell
pnpm check             # 全量质量门禁
pnpm health:deep       # 真实协议健康检查
pnpm openapi:generate  # 重建契约文档
pnpm db:migrate        # 校验 checksum 后执行尚未应用的 migration
pnpm stop:infra        # 停止但保留数据
```

## 5. M01 开发身份演练

默认身份为 `dev-admin`。Web 右上角进入“身份与接入”可切换服务端预置；也可直接调用：

```powershell
curl.exe http://localhost:3000/api/v1/auth/me -H "X-RAG-Mock-User: knowledge-reader"
curl.exe http://localhost:3000/api/v1/spaces -H "X-RAG-Mock-User: dev-admin"
```

浏览器/curl 只能提交 presetId。`X-Authenticated-Roles` 在 Mock 模式不会被读取。生产设置 `AUTH_MODE=mock` 会在启动配置校验和 Adapter 构造两处失败。

## 6. 常见故障

### Docker Registry TLS reset / EOF

这是镜像尚未进入本机，不是 Compose 语法错误。先检查公司代理、Docker Desktop Proxy、DNS 和 `docker login`，再单独执行 `docker pull <images.env 中的镜像>`。不要删除 digest 或换成 `latest` 绕过。

### Milvus 长时间 starting

先执行 `docker compose ... logs etcd minio milvus`。确认 etcd、MinIO 已 healthy，主机有足够内存，端口 `19530/9091` 未占用。首次拉取和初始化通常最慢。

### Readiness 503 但 liveness 200

这是预期语义：进程活着，但至少一个关键依赖不可用。查看响应的 `dependencies`，再运行 `pnpm health:deep` 获得协议级定位。

### 配置启动失败

错误只显示字段名与原因，不显示密钥值。对照 `.env.example`。生产模式禁止默认口令，并要求 PostgreSQL URL 包含 SSL 配置。

### M01 表不存在

先运行 `pnpm db:migrate`。迁移器使用 advisory lock 防止多实例同时执行，并在 `schema_migrations` 保存 SHA-256；已执行 SQL 被修改会拒绝继续，应该新增 migration 而不是改历史文件。

### M02 上传流程演练

1. 先用 M01 创建或选择一个具备 `WRITE` 权限的活动知识空间。
2. 打开 `/tasks`，选择文件。小文件使用单 PUT，大于 `UPLOAD_MULTIPART_THRESHOLD_BYTES` 的文件自动切片。
3. 浏览器请求 Platform API 创建会话；文件字节随后直接 PUT 到 MinIO 的短时预签名 URL。
4. 上传完成后 Platform API 执行 HEAD，再用一个 PG 事务写入 Document、Version、File、Job、10 个 Step 和 Outbox。
5. Scheduler 把 Outbox 投递到独立的 BullMQ Redis；M03 Consumer 写 Inbox 收据、领取 lease，并真正执行安全和解析流水线。

本地 Compose 通过 `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:5173` 允许浏览器直传。部署到其他前端域名时必须同步修改对象存储 CORS，且至少暴露 Multipart 所需的 `ETag` 响应头。

### Multipart 上传后提示 ETag 缺失

先在浏览器 Network 中确认分片 PUT 成功，再检查 MinIO/S3 CORS 是否允许当前 Origin 并暴露 `ETag`。不要在前端伪造 ETag；服务端需要真实 ETag 完成 Multipart 合并。

### 上传完成但接口返回 409 OBJECT_MISMATCH

依次检查对象 HEAD 的 `size`、`Content-Type` 和可用 SHA-256 是否与会话计划一致。原始文件名不会参与对象路径，路径形如 `spaces/{spaceId}/uploads/{uploadId}/files/{fileId}`。

### 任务长期 RUNNING

查询 `ingestion_jobs.lease_owner/lease_expires_at/heartbeat_at` 和当前步骤。Scheduler 会把过期 lease 重排队；达到最大尝试次数后转为 `WAITING`，需要人工判断文件问题、基础设施故障还是代码缺陷。

### M03 外网能力演练

1. 默认真实配置为 `SCANNER_ADAPTER=builtin`、`PARSER_ADAPTER=http`、`PARSER_BASE_URL=http://localhost:8104`、`OCR_ADAPTER=docling`。
2. 本机运行 `pnpm dev:document-parser-service` 启动 Node Parser；需要免费 OCR 且资源允许时，再运行 `docker compose --profile m03 --env-file deploy/docker/images.external.env -f deploy/docker/docker-compose.yml up -d docling`。
3. Windows 主机 Worker 与容器 Docling 共用预签名 URL 时，MinIO Endpoint 必须是双方都能解析的地址；只对主机有效的 `localhost` 不能被容器回访。
4. 仅演练编排可切到三个 `fixture` Adapter；production 会拒绝启动，Fixture 结果不能用来声称解析质量达标。
5. 上传后在任务抽屉查看安全结论、Provider 修订、OCR 页数、警告和 Block 预览。

Node Parser 与 Docling OCR 容器均启用了只读根文件系统、`cap_drop=ALL`、`no-new-privileges`、PID/CPU/内存上限、临时文件系统和受限处理网络。内网生产仍应由 Kubernetes/容器平台补齐 NetworkPolicy、镜像签名、Seccomp/AppArmor 和只允许访问对象存储的 egress 白名单。

### M03 任务失败怎么判断

- `RETRYABLE_PROVIDER`：网络、429、5xx、超时；有限重试，达到 `PROCESSING_MAX_ATTEMPTS` 后等待人工处理。
- `DOCUMENT_PROBLEM`：伪装格式、Hash/大小变化、恶意、密码、宏、资源超限；确定性拒绝，不反复烧资源。
- `DEVELOPER_DEFECT`：Provider JSON、协议版本、实际修订或未知响应不匹配；等待工程人员修 Adapter/契约。
- `MANUAL_REVIEW`：嵌入对象或外链需要业务管理员确认；不会静默进入 M04。

### 401 / 403

401 先检查 AUTH_MODE 和凭证来源；403 再检查 `/auth/me` 返回的映射后角色、空间 ACL 和所需权限。不要通过给浏览器加 roles Header 排障，它不是可信来源。

## 7. 清空本地数据

只有确认不需要本地数据时，才可对 `deploy/docker/docker-compose.yml` 执行 `down --volumes`。它会永久删除本项目命名卷中的 PostgreSQL、Redis、MinIO、etcd 和 Milvus 数据；日常停止请用 `pnpm stop:infra`。
