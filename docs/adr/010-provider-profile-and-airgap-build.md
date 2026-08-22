# ADR-010：受控 Provider Profile 与内网离线构建分层

- 状态：Accepted
- 日期：2026-08-21
- 关联需求：CFG-001～CFG-007、CFG-011～CFG-013

## 背景

同一套 RAG 代码需要在外网开发机和企业内网运行。两边不仅 Provider Endpoint 不同，依赖来源、基础镜像、CA、漏洞扫描方式也不同。如果把这些差异写进 Controller 或 Application Service，会形成两套业务代码；如果只准备一个 `.env`，又容易把密钥、测试 Fixture 或公网地址带入生产。运行中的任务如果跟随配置热切换，历史解析和索引结果也无法复现。

## 决策

1. 运行时只允许五个白名单画像：`test`、`external-dev`、`external-ci`、`intranet-staging`、`intranet-production`。
2. 画像到文件名使用固定映射，禁止把用户输入拼成路径；只读取真实 `.env.<profile>`，永不读取 `.example`。
3. 文件只提供非敏感默认值，宿主环境、容器 Secret 或 Secret Manager 注入值具有最高优先级。
4. `APP_ENV` 与画像必须严格配套。内网画像拒绝公网 Endpoint、Fixture/Memory Adapter、占位 revision 和不兼容的 Embedding 能力；生产继续拒绝 Mock Auth、默认凭据和非 TLS 数据库连接。
5. Application 只依赖 Port。Adapter 选择只发生在 Composition Root；未知的 PaddleOCR、模型网关或 Milvus 企业协议不在业务层增加条件分支。
6. Provider Profile 不热更新。M03/M04 Run 在开始时保存 `providerProfile`，并继续保存各自的 profile/revision；后续 M05、检索和生成 Run 沿用同一规则。
7. `PROVIDER_PROFILE` 只决定运行时 Provider；外网/内网构建方式由 Dockerfile、镜像清单和离线 Store 决定，两者不得混为一个开关。
8. 外网构建可从批准的公网源取依赖；内网 Dockerfile 只使用预装 Node 22.20.0/pnpm 11.19.0 的企业 Builder、离线 pnpm Store 和内网镜像仓库。
9. 公网使用 `pnpm audit`；内网读取企业扫描器的归一化 SCA 报告，并用 `pnpm-lock.yaml` SHA-256 防止报告错配。

## 取舍

- 五份画像文件存在少量重复，但能让审批、对比和回退清楚，优于一个包含大量条件表达式的万能 `.env`。
- 外网 Adapter 源码保留在内网代码包中但不会被未选画像实例化；这样可维护一套代码。若企业规范要求物理删除，应在内网全链路通过后建立单独变更，不直接改业务层。
- 当前只为未来 LLM、Embedding、Reranker、Milvus 固定配置契约和 fail-closed 规则；真正 Port/Adapter 按 M05、M07、M08 实施，不能把“配置存在”当成能力已上线。
- 可选 Docling OCR 的外网开发镜像目前只有不可变 tag、缺少 digest。普通开发审计会告警，正式离线制品门禁会阻断，直到制品管理员补齐批准摘要。Node Parser 和内置内容安全预检随应用构建，不需要额外运行镜像。

## 后果

- 切入内网通常只需复制模板、注入 Secret、替换内网镜像摘要；供应商协议不同才新增 Adapter。
- 已开始的 Job 不跨画像；滚动切换期间新旧实例各自完成或重试自己的任务。
- 任何新 Native/WASM 依赖都必须同步更新离线清单、目标平台包和 `allowBuilds`，否则离线门禁失败。
- 内网真实协议、GPU/CPU 架构、CA、镜像仓库和 SCA 产品仍是上线前必须收集的环境事实。
