# M02 排障：从用户现象定位到事实层

## 1. 先判断故障在哪一段

```text
创建会话失败 → Auth / 配额 / PG / MinIO initiate
PUT 失败      → 预签名过期 / CORS / 网络 / part URL
Complete 失败 → Multipart ETag / HEAD / 对象事实 / PG 事务
任务不动      → Outbox / Scheduler / BullMQ / Consumer
任务卡住      → lease / heartbeat / 下游处理器
页面不更新    → SSE / ETag / cursor / 当前权限
```

## 2. 创建会话 403

检查 `/api/v1/auth/me` 的服务端语义角色，再检查空间 ACL 是否有 WRITE。不要在浏览器里伪造 roles Header。Repository 的 SQL 还会再次检查空间权限，所以只绕 Controller 没有用。

## 3. PUT 403 SignatureDoesNotMatch

检查：

- URL 是否已超过 `expiresAt`；
- 浏览器是否改变了签名绑定的方法；
- Multipart 的 `uploadId/partNumber` 是否与 URL 一致；
- 反向代理是否重写 Host、Path 或 Query；
- 内网时钟是否漂移。

预签名 URL 不落 localStorage。刷新后向 API 重新申请。

## 4. 浏览器报 CORS，但 curl 成功

curl 不执行浏览器同源策略。检查 MinIO：

- 允许的 Origin 是否是实际前端域名；
- PUT/HEAD/POST 是否允许；
- `ETag` 是否暴露给 JavaScript；
- 网关是否吞掉 OPTIONS 预检。

## 5. Multipart Complete 提示分片不完整

比较前端计划 `partCount` 与完成请求。编号必须从 1 连续到 partCount，不能重复。ETag 要移除 HTTP Header 外层引号再提交；Adapter 会再次净化。

## 6. OBJECT_MISMATCH

执行对象 HEAD，对照 `upload_files`：

```sql
SELECT original_file_name, size_bytes, content_type, expected_sha256,
       bucket, object_key, status
FROM upload_files
WHERE id = '<file-id>';
```

注意 Multipart ETag 通常是组合摘要，不是 SHA-256。只有对象 metadata 或后续安全扫描提供可信 SHA-256 时才比较。

## 7. 有文档但没有队列任务

先查同一事务应产生的事实：

```sql
SELECT d.id, dv.id, j.id, o.id, o.published_at, o.attempts, o.last_error
FROM documents d
JOIN document_versions dv ON dv.document_id = d.id
JOIN ingestion_jobs j ON j.document_version_id = dv.id
JOIN outbox_events o ON o.aggregate_id = j.id
WHERE d.id = '<document-id>';
```

如果 Job 存在、Outbox 未发布，检查 Scheduler 日志和 Redis 6380。不要手工直接把 `published_at` 改成 now。

## 8. Outbox attempts 一直增加

- Redis 是否使用 `noeviction`；
- URL 是否指向专用 BullMQ 实例；
- BullMQ 前缀和队列名是否一致；
- 错误是否是认证、网络或脚本兼容问题；
- `last_error` 是否已经截断为安全公开信息。

## 9. RUNNING 长期不变

```sql
SELECT id, status, attempt, lease_owner, lease_expires_at, heartbeat_at,
       now() - heartbeat_at AS heartbeat_age
FROM ingestion_jobs
WHERE id = '<job-id>';
```

lease 已过期但未恢复：检查 scheduler 是否运行。恢复多次后 WAITING 是保护策略，不要无限重试有毒文件。

## 10. 页面刷新后显示“需重选文件”

这是浏览器安全边界：页面不能把用户本地 File Blob 永久保存后静默继续上传。会话事实已经恢复，但未完成文件要用户重新选择；已经 Complete 的任务从 PG 列表恢复。
