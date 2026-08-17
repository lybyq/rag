# 05｜排障：从状态事实定位，不靠猜

## 1. Job 一直 RUNNING

先查 `lease_owner/lease_expires_at/heartbeat_at/current_step`。如果 heartbeat 更新，说明 Worker 活着，继续看 Provider 延迟；如果停止，Scheduler 会在 lease 过期后重排队。不要手工把 RUNNING 直接改成功。

## 2. Scanner 一直连接失败

- 检查 `CLAMD_HOST/PORT` 和防火墙；clamd TCP 无认证，不应暴露公网。
- 用 clamd `PING` 验证服务，但不要把可达等同于签名库最新。
- 查看 Parse Run `failureClass=RETRYABLE_PROVIDER` 与稳定 `failureCode`，日志中不应出现正文。

## 3. Docling 能访问 API 但拉不到文件

预签名 URL 的 hostname 必须同时被 Docling 运行环境解析。主机上的 `localhost:9000` 对容器表示容器自身。修正 Worker 使用的 MinIO Endpoint/DNS，不要把对象改成公网可读。

## 4. Provider 返回 200 仍失败

这是正确的 fail-closed 行为。依次检查：JSON 是否有效、响应是否超过上限、Zod 字段是否完整、`protocolVersion` 是否匹配、实际 parser/OCR revision 是否等于 Profile。

## 5. OCR 页数异常

查 Parser 每页 `textCoverage/imageOnly` 和 `OCR_TEXT_COVERAGE_THRESHOLD`。如果文本 PDF 全本 OCR，通常是 Parser 没有返回可靠页级覆盖率；不要在前端改显示数字掩盖。

## 6. 快照存在但 PG 没成功

重试会 HEAD derived Key 并比较 `x-amz-meta-sha256`。相同则复用，不同则写入当前内容修订的确定性快照；PG 提交仍会验证 lease。不要删除旧对象来“修复”事务。

## 7. C 盘空间不足

本项目缓存与临时目录应放 D 盘。Docling CPU 镜像和模型缓存体积较大，先迁移 Docker data-root 或在有容量的主机运行；未经确认不要拉镜像，也不要随意移动 Docker Desktop 数据文件。
