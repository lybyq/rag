# Provider 双环境切换与内网离线部署 Runbook

## 1. 先理解两个互不替代的开关

```text
Build 路径：依赖/镜像从哪里来，是否允许联网
    ↓ 产出同一套应用镜像
Provider Profile：进程启动后连接哪套 Parser/OCR/模型/Milvus
```

`PROVIDER_PROFILE` 不是构建开关。把它设成 `intranet-production` 不会自动把 Docker Hub、npm 或公网 CA 变成内网制品；反过来，用离线 Dockerfile 构建也不会自动选择内网模型。

## 2. 配置加载顺序

进程启动时只执行一次以下流程：

1. 从宿主环境读取 `PROVIDER_PROFILE`，未设置时默认 `external-dev`。
2. 用白名单映射选择仓库根目录下唯一一个真实文件，例如 `intranet-staging -> .env.intranet-staging`。
3. 若该真实文件不存在，继续使用宿主环境；绝不读取 `.example`。
4. 宿主环境/容器 Secret 覆盖文件值，所以密钥轮换不要求重建镜像。
5. `loadAppConfig` 用 Zod 完整校验并冻结配置；任何不安全组合直接拒绝启动。

这解释了为什么 Docker Compose 的 `env_file` 可以直接把示例值注入容器，而应用本身不会偷偷读取示例文件。

## 3. 外网本地运行

本机 C 盘空间紧张时，先把 pnpm Store、临时目录和 Parser 数据放到 D 盘：

```powershell
pnpm config set store-dir D:\.pnpm-store
New-Item -ItemType Directory -Force D:\codex-temp\rag
$env:TEMP='D:\codex-temp\rag'
$env:TMP='D:\codex-temp\rag'
$env:PARSER_TEMP_ROOT='D:\coding\rag\.data\parser-runtime'
```

复制模板并把 DeepSeek Key 只写入被 Git 忽略的真实文件：

```powershell
Copy-Item .env.external-dev.example .env.external-dev
$env:PROVIDER_PROFILE='external-dev'
pnpm install --frozen-lockfile
pnpm dev:infra
pnpm db:migrate
pnpm dev:services
```

也可以用 Compose 同时构建应用和基础设施：

```powershell
pnpm dev:docker
```

外网默认使用项目自带的 Node 多格式 Parser、可选免费 Docling OCR 和 DeepSeek-compatible LLM。Embedding/Reranker Fixture 只能演练流程，不能作为检索质量验收证据。

## 4. 外网准备离线制品

先在干净工作区执行：

```powershell
pnpm install --frozen-lockfile
pnpm offline:audit
pnpm offline:prepare
pnpm offline:release-check
```

`offline:release-check` 会把未锁 digest 的镜像告警升级为错误。因此当前必须先在 `deploy/docker/images.external.env` 为可选 Docling OCR 镜像补企业批准的 `@sha256:...`，不能用 `latest` 绕过。项目自带 Parser 和内容安全预检均随应用镜像构建，不再依赖额外扫描服务镜像。

建议交付包至少包含：源码或签名源代码归档、`pnpm-lock.yaml`、`config/offline-dependency-manifest.yaml`、`.offline/pnpm-store`、pnpm 11.19.0 安装包、Node/pnpm Builder 镜像、Runtime 镜像、所有基础设施/Provider 镜像及 SHA-256 清单。`.offline` 不提交 Git。

## 5. 内网首次落地

1. 把全部镜像导入企业镜像仓库并完成漏洞扫描、签名和 digest 固化。
2. 复制 `deploy/docker/images.intranet.example.env` 为被 Git 忽略的 `deploy/docker/images.intranet.env`，把每个 `registry.invalid` 替换为真实内网仓库和 digest。
3. 复制 `.env.intranet-staging.example` 为 `.env.intranet-staging`，填写网关、证书、Provider 元数据和非默认凭据；Secret 优先由部署平台注入。
4. 若内网协议与项目标准 HTTP/OpenAI-compatible 契约一致，只改配置；若不同，在对应基础设施库新增 Adapter 和契约测试，不改 Controller/Application/Domain。
5. 使用预先导入的 Builder 构建，安装步骤必须保持 `--offline --frozen-lockfile`。
6. 执行 migration、Provider 契约、Golden、真实脱敏样本和负载测试；预生产通过后再生成 production 配置。

替换镜像后先执行 `pnpm images:audit:intranet`；任何公网/隐式 Docker Hub 地址、`registry.invalid` 或未锁 digest 的条目都会失败。

内网应用镜像示例：

```powershell
docker build --network=none --file deploy/docker/Dockerfile.backend.airgap `
  --build-arg NODE_BUILDER_IMAGE=<内网builder@sha256> `
  --build-arg NODE_RUNTIME_IMAGE=<内网runtime@sha256> `
  --build-arg APP_NAME=platform-api `
  --tag <内网仓库>/rag/platform-api:<版本> .
```

完全替换镜像清单后检查并启动：

```powershell
$env:RAG_ENV_FILE='../../.env.intranet-staging'
docker compose --env-file deploy/docker/images.intranet.env `
  -f deploy/docker/docker-compose.intranet.yml config --quiet
docker compose --env-file deploy/docker/images.intranet.env `
  -f deploy/docker/docker-compose.intranet.yml up -d
pnpm health:deep
```

Compose 会先用 `PLATFORM_API_IMAGE` 启动一次性 `migrate` 服务；它使用 advisory lock 和 migration checksum，成功后四个后端进程才启动。Kubernetes/企业发布平台应把同一命令建成部署前 Job，而不是让每个副本各自迁移。`docker-compose.intranet.yml` 只部署已构建应用，不擅自假设企业 PostgreSQL、Redis、MinIO、Milvus、OCR 和模型网关的部署拓扑。

## 6. 内网 SCA 门禁

企业扫描器需归一化为：

```json
{
  "schemaVersion": 1,
  "scanner": "company-approved-sca",
  "generatedAt": "2026-08-21T10:00:00+08:00",
  "status": "pass",
  "lockfileSha256": "64位小写十六进制",
  "vulnerabilities": { "critical": 0, "high": 0, "medium": 0, "low": 0 }
}
```

运行：

```powershell
$env:INTRANET_SCA_REPORT='D:\rag-artifacts\sca-report.json'
pnpm security:audit:intranet
```

脚本不会调用任意外部命令，只验证报告状态、高危数量和当前 lockfile 指纹。没有企业扫描器时必须记录验收缺口，不能伪造 `pass`。

## 7. 切换、灰度与回退

1. 创建新的不可变 Profile ID/revision，先在 `intranet-staging` 做兼容性和 Golden 测试。
2. 滚动发布新实例；旧实例不热更新，已经开始的任务继续使用旧配置。
3. M03/M04 Run 会保存 `providerProfile` 和具体算法/Provider revision，排查时先看这些事实，不根据“当前配置”猜历史结果。
4. 发现质量或协议问题时停止新实例接流量，恢复上一份环境注入和镜像 digest，再创建新 content revision 重处理；不要覆盖历史 Run。
5. M05 建新 Collection/alias 后才能切换 Embedding 维度或输出模式，禁止把新维度写入旧 Collection。

## 8. 常见故障与面试追问

- 为什么不让 `.example` 自动生效？示例含占位符，自动读取会让测试配置被误当生产事实；Compose 若要演练会显式注入。
- 为什么环境变量覆盖文件？Secret 轮换和 Kubernetes Secret 不应要求修改镜像或 Git 文件。
- 为什么不热切换？一个 Job 跨两套模型会失去幂等性、可复现性和审计解释。
- 为什么 cnpm 还不够？Native/WASM 包、可选平台包、Node headers、浏览器和 Docker 基础镜像不一定由普通 registry 完整提供。
- 为什么保留外网 Adapter？一套源码能持续跑相同契约测试；安全边界是“未选择就不实例化、未导入镜像就不部署”，不是在业务层维护 fork。
- 为什么内外网漏洞扫描分两条命令？公网 audit API 在隔离网不可达，治理目标相同，但证据来源不同；内网报告还必须绑定 lockfile hash。
