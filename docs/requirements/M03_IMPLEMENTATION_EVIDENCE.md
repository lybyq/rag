# M03 文件安全、解析与 OCR：实施证据

> 日期：2026-08-17。本文严格区分自动化实现证据与尚未在当前机器执行的真实 Provider 质量验证。

## 1. 需求映射

| 需求    | 主要实现                                                                                         | 自动化证据                                  |
| ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| PAR-001 | `file-detection.ts`、流式 SHA/大小、quarantine/derived 分离                                      | 伪装 PDF、Office ZIP、对象 Hash 测试        |
| PAR-002 | `MalwareScannerPort`、clamd INSTREAM、Fixture                                                    | clamd CLEAN/FOUND/未知协议测试              |
| PAR-003 | `security-policy.ts`、`FileStructureInspection`、生产禁用不完整 Docling Parser                   | 宏/密码/炸弹/页/像素/表格策略测试、配置测试 |
| PAR-004 | Compose `m03` profile 的只读根、cap drop、no-new-privileges、CPU/内存/PID/tmpfs/internal network | `docker compose config --quiet`             |
| PAR-005 | Parser/OCR Port、Zod Schema、协议与 revision 校验                                                | 成功、缺字段、版本漂移测试                  |
| PAR-006 | 九格式检测与 Docling/HTTP/Fixture 路由                                                           | 9 个 Golden 路由 Snapshot                   |
| PAR-007 | `selectOcrPages/mergeOcrBlocks`                                                                  | 混合页只请求低覆盖页测试                    |
| PAR-008 | OCR page/block bbox/confidence/version、低置信 Issue                                             | 编排测试断言页 2 告警                       |
| PAR-009 | `ParsedBlockCandidate -> DocumentBlockDraft`，M03 停在 CHUNK WAITING                             | 类型边界、Repository 事务                   |
| PAR-010 | ordinal + version/content hash 稳定 ID，独立 originalText                                        | 稳定 ID/原文测试                            |
| PAR-011 | table rows/header/merged、sheet/slide/bbox 契约与 Docling 映射                                   | Zod/Docling mapper/Golden 契约              |
| PAR-012 | derived 版本化 Key、SHA metadata、HEAD 复用                                                      | MinIO Adapter + 编排测试                    |
| PAR-013 | Abort/timeout/响应上限/有限重试、三类故障、lease fencing                                         | 429、协议错误、对象错误与 PG lease SQL      |
| PAR-014 | `test/fixtures/m03/golden-manifest.json` + 9 个 Jest Snapshot                                    | 9/9 Snapshot passed                         |
| PAR-015 | 四个管理 API、任务抽屉解析面板、Profile 角色限制                                                 | OpenAPI gate、Vue 测试、管理员授权测试      |

## 2. 已执行门禁

```text
Backend tests: 80 passed
Frontend tests: 5 passed
M02 + M03 PostgreSQL integration: 4 passed
TypeScript strict: passed
Vue typecheck/build: passed
ESLint max warnings 0: passed
Dependency boundaries: passed (189 modules)
Migration checksum/order: passed (3 migrations)
OpenAPI current: passed
Docker Compose static config: passed
4 backend builds + Vue production build: passed
```

M03 指标：

- `rag_m03_processing_total{result}`：完成、复核、拒绝、失败。
- `rag_m03_processing_duration_seconds{result}`：端到端耗时直方图。
- 标签不包含 userId、documentId、jobId、文件名或 URL。

## 3. 关键安全事实

- 原始对象只在 quarantine；只有 `CLEAN` 文件才能写 derived。
- Scanner 必须完整消费对象流，扫描字节数、重新计算大小和 SHA 任一不一致即拒绝。
- ClamAV 异常、未知响应和 Parser Schema 漂移都不会伪装成 CLEAN。
- 嵌入对象/外链停止在人工复核，不进入 M04。
- production 禁止 Fixture，也禁止把结构安全信息不完整的 Docling 直连作为 Parser；内网 `http` Parser 必须返回完整 inspection。
- Provider 长调用期间独立续租；所有数据库提交再次校验 lease owner 和有效期。

## 4. 当前环境未执行且不能虚构的证据

当前机器 C 盘可用空间为 0。Docling CPU 镜像和模型缓存较大，本轮遵照用户要求没有拉取镜像，也没有迁移/删除 Docker Desktop 数据。因此以下项目需要在 D 盘 Docker data-root 或预生产机器补跑：

- 真实 ClamAV + EICAR、签名库版本和超时；
- 真实 Docling/内网 Parser 对复杂 PDF、合并 Excel、PPT 图文的 Block 质量；
- 真实 PaddleOCR/内网 OCR 的 bbox、置信度和低质量图片；
- 真实 MinIO 的 source URL 容器 DNS、derived SHA 复用；
- 中型规模并发、资源上限、kill、soak 和故障恢复。

Fixture/合成 Golden 证明契约和编排，不代表真实解析准确率。补跑步骤见本地 Runbook 和 `M03-acceptance.md`。
