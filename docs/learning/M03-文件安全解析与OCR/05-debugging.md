# 05｜排障：从状态事实定位，不靠猜

## 1. Job 一直 RUNNING

先查 `lease_owner/lease_expires_at/heartbeat_at/current_step`。如果 heartbeat 更新，说明 Worker 活着，继续看 Provider 延迟；如果停止，Scheduler 会在 lease 过期后重排队。不要手工把 RUNNING 直接改成功。

## 2. 内置 Scanner 异常或误报

- 查看 `SCANNER_PROFILE_ID/REVISION` 和 `BUILTIN_*` signatureName；规则修改必须升级 revision。
- `SCANNER_FILE_TOO_LARGE` 表示上游对象大小事实或部署上限不一致，不能改成 CLEAN 绕过。
- 内置 Scanner 无网络连接问题，也没有病毒库；若企业要求完整反恶意软件检测，应实现新的 `MalwareScannerPort` Adapter。

## 3. Node Parser 能访问 API 但拉不到文件

先看 `PARSER_SOURCE_HOST_FORBIDDEN`：预签名 URL 的 hostname 必须同时出现在 `PARSER_ALLOWED_SOURCE_HOSTS` 且能被 Parser 容器解析。主机上的 `localhost:9000` 对容器表示容器自身；Compose 应使用 `minio:9000`。不要为解决 DNS 把对象改成公网可读，也不要允许重定向。

## 4. Provider 返回 200 仍失败

这是正确的 fail-closed 行为。依次检查：JSON 是否有效、响应是否超过上限、Zod 字段是否完整、`protocolVersion` 是否匹配、实际 parser/OCR revision 是否等于 Profile。

## 5. OCR 页数异常

查 Parser 的 `pages/ocrCandidates`、Target kind/reason 和 `OCR_TEXT_COVERAGE_THRESHOLD`。如果文本 PDF 全本 OCR，通常是覆盖率代理不适合该模板；如果 Office 图片没 OCR，检查 `archiveEntryPath` 和 OCR 网关是否支持 EMBEDDED_IMAGE。不要在前端改显示数字掩盖。

## 6. 快照存在但 PG 没成功

重试会 HEAD derived Key 并比较 `x-amz-meta-sha256`。相同则复用，不同则写入当前内容修订的确定性快照；PG 提交仍会验证 lease。不要删除旧对象来“修复”事务。

## 7. C 盘空间不足

本项目缓存与临时目录应放 D 盘。命令执行前设置 `TEMP/TMP=D:\codex-temp\rag-m03`，`PARSER_TEMP_ROOT` 使用 D 盘项目目录；Docker data-root 也应迁到有容量的数据盘。未经确认不要在已满 C 盘拉取可选 Docling OCR 镜像。
