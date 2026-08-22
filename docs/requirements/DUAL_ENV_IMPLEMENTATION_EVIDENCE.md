# Provider 双环境与离线部署：实施证据

> 日期：2026-08-22。本轮交付的是 M05 开始前的跨模块配置/部署地基，不把尚未实现的 Embedding、Reranker、LLM、Milvus 业务 Adapter 宣称为已上线。

## 1. 已完成

| 能力             | 实现                                                                      | 自动化证据                                                      |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 受控 Profile     | `provider-profile.ts` 固定五种画像、白名单文件映射、宿主环境优先          | 固定文件、覆盖优先级、路径穿越拒绝测试                          |
| 统一配置         | Parser/OCR/LLM/Embedding/Reranker/Vector/Milvus Zod 配置与冻结对象        | 外网选择、内网合法/非法矩阵测试                                 |
| 生产 fail closed | 拒绝 Fixture/Memory/Mock、占位 revision、公开 Endpoint、错误维度/能力组合 | `app-config.spec.ts`                                            |
| 运行快照         | M03/M04 Run 新增 `provider_profile`，保留原有具体 profile/revision        | Application 单测、migration gate、严格类型检查                  |
| 外网容器         | 基础设施 Compose + 五个应用 Overlay，镜像参数化                           | 三组 `docker compose config --quiet`                            |
| 内网容器         | 只使用预构建内网应用镜像的 Compose；保留不可路由占位符                    | 内网 Compose 静态门禁                                           |
| 离线构建         | airgap Dockerfile 只执行 `pnpm install --offline --frozen-lockfile`       | Dockerfile 静态审查；真实 `--network=none` 待内网镜像导入后补跑 |
| 依赖治理         | 双平台 lockfile、原生模块清单、安装脚本白名单、远程源码拒绝               | `pnpm offline:audit`                                            |
| 安全审计         | 公网 `pnpm audit` 与绑定 lockfile SHA-256 的内网报告分流                  | SCA Schema/门禁脚本；企业报告待内网补跑                         |

## 2. 本轮已执行门禁

```text
Backend tests: 148 passed; snapshots: 19 passed
Frontend tests: 7 passed
M01～M04 PostgreSQL/Redis integration: 11 passed; profile snapshot migration applied locally
TypeScript strict + Vue typecheck: passed
ESLint + dependency boundaries: passed (227 modules / 488 dependencies)
Migration naming/destructive gate: 5 migrations passed
Docker Compose static config: external infra/apps/intranet passed
Offline dependency audit: 7 native baselines passed with 1 non-strict warning
5 backend builds + Vue production build: passed
OpenAPI current: 2 files passed
Production dependency audit: critical/high/moderate 均为 0
```

当前非严格审计只对可选 Docling OCR 镜像未补 digest 给出告警。`OFFLINE_AUDIT_STRICT=true` 会按设计失败，因此在制品管理员补齐批准摘要前，正式离线制品仍不能标记为可发布。

## 3. 有意保留的后续工作

- M03 内网 Parser/PaddleOCR 的原始协议未知：先复用标准 HTTP Adapter；不兼容时基于真实样例新增 Adapter 和同一套契约测试。
- M05 实现 EmbeddingPort、Milvus VectorStorePort、启动 metadata 握手、Collection/alias 发布与全量重建。
- M07/M08 实现 Reranker/LLM Port 与 Adapter；当前只有配置契约和 fail-closed 规则。
- 所有后续 Index/Query/Answer Run 都要保存 Provider Profile、model/revision/protocol/capabilities 快照。
- 内网完成 `pnpm install --offline`、`docker build --network=none`、企业 SCA、真实脱敏 Golden 和中型负载/Soak。

## 4. 验收边界

本轮可以证明“同一套代码如何受控选择环境、如何准备离线构建、如何拒绝明显错误的内网配置”；不能证明未知内网 Provider 协议已兼容，也不能用 Fixture 结果证明检索质量。这个边界是上线审计的一部分，不是遗漏说明。
