# 03｜代码走读：按执行顺序理解每个文件

## 1. 契约真相源

从 `libs/contracts/src/document-parsing.ts` 开始。重点看：

- `ParserResultSchema/OcrResultSchema`：远端 JSON 进入业务代码前的运行时边界。
- `DocumentBlockSchema`：M04 唯一允许消费的结构。
- `DocumentParseRunSchema`：Profile、修订、Hash、耗时和失败原因的审计事实。

TypeScript 类型只在编译期存在，不能防止内网 Provider 升级后少返回字段；Zod 才能在运行时 fail closed。

## 2. 纯领域规则

`file-detection.ts` 先读魔数，再用扩展名和声明 MIME 收窄。ZIP 不会被当成通用安全文件，只允许被识别为明确 Office Open XML 格式。

`security-policy.ts` 把 Scanner 与结构检查合并。恶意、密码、宏、压缩/页/像素/表格超限直接 `REJECTED`；嵌入对象和外链进入 `MANUAL_REVIEW`。

`block-normalization.ts` 做三件事：保留 `originalText`；对 `text` 做可预测空白规范化；使用版本、ordinal 和内容 Hash 生成稳定 ID。

## 3. Provider Adapter

`clamd-scanner.adapter.ts` 的帧结构是：命令 `zINSTREAM\0`，随后每块先写 4 字节大端长度，再写内容，最后写 4 个零字节。使用流而不是 Buffer 是为了让 2 GiB 上限文件不占满 Node 堆。

`http-json.client.ts` 统一 Deadline、Abort、响应大小、429/5xx 有限重试。Adapter 只负责协议转换；是否重试最终由稳定错误分类决定。

`docling.adapter.ts` 是外网免费开发路径。它把 Docling `texts/tables/pictures/prov/bbox` 映射到统一 Block。由于原生 Docling 不证明宏/嵌入对象/外链已完整检查，production 启动校验禁止把它直接作为安全 Parser。

## 4. 应用编排

`DocumentProcessingService.process()` 顺序不能随意交换：

1. 验证当前 Worker lease，创建/恢复 Parse Run。
2. 对 MinIO 流执行扫描，同时重算大小、SHA 和头部。
3. 识别格式，签发短时 GET URL。
4. Parser 隔离执行并返回结构检查。
5. 安全策略决定拒绝、复核或继续。
6. 只对选中的页调用 OCR。
7. 合并、规范化、生成稳定 Block。
8. 写 derived 快照并验证 SHA 复用。
9. PG 原子写 Block/Issue/Run，把任务停在 M04 `CHUNK WAITING`。

## 5. 数据库提交

`PostgresDocumentProcessingRepository` 所有结果提交前都 `assertLease`。即使旧 Worker 在网络恢复后返回结果，只要 lease 已过期或被别的 Worker 领取，它就不能覆盖新结果。这是分布式 Worker 最重要的“栅栏”之一。
