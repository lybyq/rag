# 外部业务调用最短流程

这份示例只演示当前已经实现的接口：创建空间、批量直传、逐文件完成、查看真实入库进度、提问和查看引用。所有请求都走 Web 网关同一个地址，例如 `http://10.0.0.20:8080`。

联调阶段 `AUTH_MODE=mock` 时使用服务端预置身份 ID；不能在请求里自报 `userId` 或 `roles`：

```powershell
$baseUrl = 'http://10.0.0.20:8080'
$headers = @{ 'X-RAG-Mock-User' = 'dev-admin' }
```

正式 `trusted-header` 或 `jwt` 模式必须由企业网关生成身份/签名或令牌，业务程序不能自己拼管理员角色。

## 1. 创建知识空间

```powershell
$spaceResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v1/spaces" `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ code='finance-policy'; name='财务制度'; description='财务制度知识库' } | ConvertTo-Json)
$spaceId = $spaceResponse.data.id
```

已有空间可直接使用已有 `$spaceId`，不需要重复创建。

## 2. 创建多文件批次

下面只提交元数据，文件字节不会穿过 Platform API。`clientFileId` 只需在本批次内唯一；`externalSourceId + externalDocumentId` 是长期业务主键；`sha256` 必须由业务侧对真实文件计算。

```powershell
$path1 = 'D:\import\差旅制度.txt'
$path2 = 'D:\import\报销制度.pdf'
$files = @(
  @{ clientFileId='file-001'; externalSourceId='finance-system'; externalDocumentId='travel-policy'; originalFileName='差旅制度.txt'; sizeBytes=(Get-Item $path1).Length; contentType='text/plain'; sha256=(Get-FileHash $path1 -Algorithm SHA256).Hash.ToLowerInvariant() },
  @{ clientFileId='file-002'; externalSourceId='finance-system'; externalDocumentId='expense-policy'; originalFileName='报销制度.pdf'; sizeBytes=(Get-Item $path2).Length; contentType='application/pdf'; sha256=(Get-FileHash $path2 -Algorithm SHA256).Hash.ToLowerInvariant() }
)
$batchHeaders = @{} + $headers
$batchHeaders['Idempotency-Key'] = 'finance-import-20260913-001'
$batchResponse = Invoke-RestMethod -Method Post `
  -Uri "$baseUrl/api/v1/spaces/$spaceId/document-batches" `
  -Headers $batchHeaders -ContentType 'application/json' `
  -Body (@{ files=$files } | ConvertTo-Json -Depth 5)
$batchId = $batchResponse.data.batchId
$uploadPlans = $batchResponse.data.uploadSession.files
```

最多 100 个文件。相同 Idempotency-Key 和相同 Body 会返回原 batch；同键不同 Body 返回 409。每个文件独立上传、独立完成、独立入队；一个文件失败不会回滚已经成功的文件。

## 3. 上传并完成每个小文件

`SINGLE` 文件直接 PUT 到它自己的短时 `uploadUrl`。上传 URL 过期后，重新 GET `/api/v1/uploads/{batchId}` 获取新 URL。

```powershell
$plan = $uploadPlans | Where-Object clientFileId -eq 'file-001'
Invoke-WebRequest -Method Put -Uri $plan.uploadUrl -InFile $path1 `
  -ContentType 'text/plain'

$completeResponse = Invoke-RestMethod -Method Post `
  -Uri "$baseUrl/api/v1/uploads/$batchId/complete" `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ fileId=$plan.fileId; parts=@() } | ConvertTo-Json)
$jobId = $completeResponse.data.job.id
```

`MULTIPART` 文件先 POST `/api/v1/uploads/{batchId}/parts` 申请分片 URL，PUT 每个分片并保存对象存储返回的 ETag，最后把 `partNumber + etag` 数组提交给同一个 complete 接口。重复 complete 同一个 `fileId` 会返回第一次创建的文档和 Job，不会重复入队。

## 4. 看批次和每个文件的真实进度

```powershell
$batch = Invoke-RestMethod -Method Get `
  -Uri "$baseUrl/api/v1/document-batches/$batchId" -Headers $headers
$batch.data.files | Format-Table originalFileName,uploadStatus,jobStatus,currentStep,overallPercent,publicMessage

$job = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/v1/jobs/$jobId" -Headers $headers
$events = Invoke-RestMethod -Method Get `
  -Uri "$baseUrl/api/v1/jobs/$jobId/events/poll?after=0&limit=100" -Headers $headers
```

只有 Job 到达 `SUCCEEDED` 且 `PUBLISH` 完成，内容才是可检索状态；浏览器上传 100% 不等于已经发布。

## 5. 发布完成后提问

```powershell
$conversation = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v1/conversations" `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ title='外部业务联调' } | ConvertTo-Json)
$conversationId = $conversation.data.id

$runHeaders = @{} + $headers
$runHeaders['Idempotency-Key'] = [guid]::NewGuid().ToString()
$run = Invoke-RestMethod -Method Post `
  -Uri "$baseUrl/api/v1/conversations/$conversationId/runs" `
  -Headers $runHeaders -ContentType 'application/json' `
  -Body (@{ question='北京出差的住宿标准是多少？'; requestedSpaceIds=@($spaceId) } | ConvertTo-Json)
$runId = $run.data.run.id

Invoke-RestMethod -Method Get -Uri "$baseUrl/api/v1/runs/$runId" -Headers $headers
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/v1/runs/$runId/events/poll?after=0&limit=100" -Headers $headers
```

最终消息中的 `citationId` 可通过 `GET /api/v1/citations/{citationId}` 读取；服务会按当前身份再次检查 ACL、文档版本和在线 Manifest，撤权后的旧引用不会继续泄漏正文。

## 当前边界

- 已支持批次创建、逐文件幂等完成、状态轮询和并发安全发布。
- 已实现 `externalSourceId + externalDocumentId` 长期映射：同内容 Hash 返回原事实，内容变化创建同一 Document 的新 Version；旧版仍由当前 Manifest 提供服务，直到新版对账和发布成功。
- 当前没有 Webhook；外部系统通过批次和 Job 接口轮询，并保存返回的 `documentId`、`documentVersionId` 和 `jobId`。
- 初版只接收显式上传的文件，不扫描任意内网目录，也不抓取任意 URL。
