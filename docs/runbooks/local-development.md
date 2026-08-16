# M00 本地开发与故障排查

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
pnpm health:deep
pnpm seed:dev
pnpm dev:services
```

也可运行 `pnpm dev:all`，它依次启动基础设施、创建开发 Bucket，再并行启动四个后端和 Web。

## 3. 入口

| 服务                  | 地址                                       |
| --------------------- | ------------------------------------------ |
| Web Console           | `http://localhost:5173`                    |
| Platform API liveness | `http://localhost:3000/api/v1/health/live` |
| Query API liveness    | `http://localhost:3001/api/v1/health/live` |
| Ingestion probe       | `http://localhost:3002/api/v1/health/live` |
| Scheduler probe       | `http://localhost:3003/api/v1/health/live` |
| MinIO Console         | `http://localhost:9001`                    |

`/health/live` 只看进程；`/health/ready` 会真实访问 PostgreSQL、两个 Redis、MinIO 和 Milvus；`/metrics` 输出 Prometheus 指标。

## 4. 日常命令

```powershell
pnpm check             # 全量质量门禁
pnpm health:deep       # 真实协议健康检查
pnpm openapi:generate  # 重建契约文档
pnpm stop:infra        # 停止但保留数据
```

## 5. 常见故障

### Docker Registry TLS reset / EOF

这是镜像尚未进入本机，不是 Compose 语法错误。先检查公司代理、Docker Desktop Proxy、DNS 和 `docker login`，再单独执行 `docker pull <images.env 中的镜像>`。不要删除 digest 或换成 `latest` 绕过。

### Milvus 长时间 starting

先执行 `docker compose ... logs etcd minio milvus`。确认 etcd、MinIO 已 healthy，主机有足够内存，端口 `19530/9091` 未占用。首次拉取和初始化通常最慢。

### Readiness 503 但 liveness 200

这是预期语义：进程活着，但至少一个关键依赖不可用。查看响应的 `dependencies`，再运行 `pnpm health:deep` 获得协议级定位。

### 配置启动失败

错误只显示字段名与原因，不显示密钥值。对照 `.env.example`。生产模式禁止默认口令，并要求 PostgreSQL URL 包含 SSL 配置。

## 6. 清空本地数据

只有确认不需要本地数据时，才可对 `deploy/docker/docker-compose.yml` 执行 `down --volumes`。它会永久删除本项目命名卷中的 PostgreSQL、Redis、MinIO、etcd 和 Milvus 数据；日常停止请用 `pnpm stop:infra`。
