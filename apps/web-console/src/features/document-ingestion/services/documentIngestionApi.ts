/**
 * M02 浏览器 API Adapter。
 * Platform API 只接收 JSON 元数据；文件 Blob 只通过预签名 URL 发送到 MinIO。
 */
import {
  CompleteUploadEnvelopeSchema,
  DocumentListEnvelopeSchema,
  IngestionJobEnvelopeSchema,
  IngestionJobEventListEnvelopeSchema,
  IngestionJobListEnvelopeSchema,
  UploadPartListEnvelopeSchema,
  UploadSessionEnvelopeSchema,
  DocumentBlockListEnvelopeSchema,
  ParseRunDetailEnvelopeSchema,
  ParseRunListEnvelopeSchema,
  KnowledgeProcessingRunListEnvelopeSchema,
  KnowledgeProcessingRunDetailEnvelopeSchema,
  KnowledgeChunkListEnvelopeSchema,
  QualityReviewResultEnvelopeSchema,
  type CompleteUploadRequest,
  type CompleteUploadResult,
  type CreateUploadPartsRequest,
  type CreateUploadSessionRequest,
  type CursorPage,
  type Document,
  type DocumentBlock,
  type DocumentParseRun,
  type IngestionExecutionStatus,
  type IngestionJob,
  type IngestionJobEvent,
  type ParseIssue,
  type DocumentQualityReport,
  type KnowledgeChunk,
  type KnowledgeProcessingRun,
  type QualityFinding,
  type ReviewQualityRequest,
  type UploadPartInstruction,
  type UploadSession,
} from '@rag/contracts';
import {
  PlatformApiError,
  platformApiFetch,
  platformApiRawFetch,
} from '../../identity/services/platformApi';

/** 读取一个版本保留的全部 Parse Run 历史，最新修订排在前面。 */
export function listDocumentParseRuns(versionId: string): Promise<readonly DocumentParseRun[]> {
  return platformApiFetch(
    `/api/v1/document-versions/${encodeURIComponent(versionId)}/parse-runs`,
    ParseRunListEnvelopeSchema,
  ).then((response) => response.data.items);
}

/** 读取 Parse Run 和可公开的问题列表。 */
export function getDocumentParseRun(
  parseRunId: string,
): Promise<{ run: DocumentParseRun; issues: readonly ParseIssue[] }> {
  return platformApiFetch(
    `/api/v1/parse-runs/${encodeURIComponent(parseRunId)}`,
    ParseRunDetailEnvelopeSchema,
  ).then((response) => response.data);
}

/** 按稳定 ordinal 分页读取 Block，避免一次把大文档正文送入浏览器。 */
export function listDocumentBlocks(
  parseRunId: string,
  afterOrdinal = 0,
  limit = 100,
): Promise<{ items: readonly DocumentBlock[]; nextOrdinal: number | null }> {
  const query = new URLSearchParams({
    afterOrdinal: String(afterOrdinal),
    limit: String(limit),
  });
  return platformApiFetch(
    `/api/v1/parse-runs/${encodeURIComponent(parseRunId)}/blocks?${query.toString()}`,
    DocumentBlockListEnvelopeSchema,
  ).then((response) => response.data);
}

/** 读取文档版本保留的全部 M04 运行历史。 */
export function listKnowledgeProcessingRuns(
  versionId: string,
): Promise<readonly KnowledgeProcessingRun[]> {
  return platformApiFetch(
    `/api/v1/document-versions/${encodeURIComponent(versionId)}/knowledge-runs`,
    KnowledgeProcessingRunListEnvelopeSchema,
  ).then((response) => response.data.items);
}

/** 读取一次 M04 运行的质量报告和发现项。 */
export function getKnowledgeProcessingRun(processingRunId: string): Promise<{
  run: KnowledgeProcessingRun;
  report: DocumentQualityReport;
  findings: readonly QualityFinding[];
}> {
  return platformApiFetch(
    `/api/v1/knowledge-runs/${encodeURIComponent(processingRunId)}`,
    KnowledgeProcessingRunDetailEnvelopeSchema,
  ).then((response) => response.data);
}

/** 按稳定 ordinal 分页读取 Parent/Child Chunk。 */
export function listKnowledgeChunks(
  processingRunId: string,
  afterOrdinal = 0,
  limit = 100,
): Promise<{ items: readonly KnowledgeChunk[]; nextOrdinal: number | null }> {
  const query = new URLSearchParams({ afterOrdinal: String(afterOrdinal), limit: String(limit) });
  return platformApiFetch(
    `/api/v1/knowledge-runs/${encodeURIComponent(processingRunId)}/chunks?${query.toString()}`,
    KnowledgeChunkListEnvelopeSchema,
  ).then((response) => response.data);
}

/** 提交带原因和乐观锁版本的质量审核。 */
export function reviewKnowledgeQuality(
  processingRunId: string,
  request: ReviewQualityRequest,
): Promise<{ report: DocumentQualityReport; reprocessJobId: string | null }> {
  return platformApiFetch(
    `/api/v1/knowledge-runs/${encodeURIComponent(processingRunId)}/reviews`,
    QualityReviewResultEnvelopeSchema,
    { method: 'POST', body: JSON.stringify(request) },
  ).then((response) => response.data);
}

/** 创建上传会话。 */
export function createUploadSession(request: CreateUploadSessionRequest): Promise<UploadSession> {
  return platformApiFetch('/api/v1/uploads', UploadSessionEnvelopeSchema, {
    method: 'POST',
    body: JSON.stringify(request),
  }).then((response) => response.data);
}

/** 页面刷新后恢复会话事实和新预签名 URL。 */
export function getUploadSession(uploadId: string): Promise<UploadSession> {
  return platformApiFetch(
    `/api/v1/uploads/${encodeURIComponent(uploadId)}`,
    UploadSessionEnvelopeSchema,
  ).then((response) => response.data);
}

/** 为指定分片签发 URL。 */
export function createUploadParts(
  uploadId: string,
  request: CreateUploadPartsRequest,
): Promise<readonly UploadPartInstruction[]> {
  return platformApiFetch(
    `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts`,
    UploadPartListEnvelopeSchema,
    { method: 'POST', body: JSON.stringify(request) },
  ).then((response) => response.data.items);
}

/** 完成一个上传文件并获得稳定任务 ID。 */
export function completeUpload(
  uploadId: string,
  request: CompleteUploadRequest,
): Promise<CompleteUploadResult> {
  return platformApiFetch(
    `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
    CompleteUploadEnvelopeSchema,
    { method: 'POST', body: JSON.stringify(request) },
  ).then((response) => response.data);
}

/** 取消整批会话；对象清理由服务端执行。 */
export async function cancelUploadSession(uploadId: string): Promise<void> {
  const response = await platformApiRawFetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new PlatformApiError(
      'UPLOAD_CANCEL_FAILED',
      `上传会话取消失败（HTTP ${response.status}）`,
      response.status,
    );
  }
}

/** 文档列表供上传完成后的结果区使用。 */
export function listDocuments(spaceId?: string): Promise<{ items: Document[]; page: CursorPage }> {
  const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : '';
  return platformApiFetch(`/api/v1/documents${query}`, DocumentListEnvelopeSchema).then(
    (response) => response.data,
  );
}

/** 任务列表查询。 */
export function listIngestionJobs(filters: {
  spaceId?: string;
  status?: IngestionExecutionStatus;
}): Promise<{ items: IngestionJob[]; page: CursorPage }> {
  const query = new URLSearchParams();
  if (filters.spaceId) query.set('spaceId', filters.spaceId);
  if (filters.status) query.set('status', filters.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return platformApiFetch(`/api/v1/jobs${suffix}`, IngestionJobListEnvelopeSchema).then(
    (response) => response.data,
  );
}

/** 读取一个任务和所有步骤。 */
export function getIngestionJob(jobId: string): Promise<IngestionJob> {
  return platformApiFetch(
    `/api/v1/jobs/${encodeURIComponent(jobId)}`,
    IngestionJobEnvelopeSchema,
  ).then((response) => response.data);
}

/** 取消任务。 */
export function cancelIngestionJob(jobId: string, reason: string): Promise<IngestionJob> {
  return platformApiFetch(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
    IngestionJobEnvelopeSchema,
    { method: 'POST', body: JSON.stringify({ reason }) },
  ).then((response) => response.data);
}

export interface EventPollResult {
  readonly notModified: boolean;
  readonly etag?: string;
  readonly items: readonly IngestionJobEvent[];
  readonly nextCursor: number;
}

/** SSE 不可用时使用 If-None-Match + 游标恢复，不重复消费事件。 */
export async function pollIngestionJobEvents(
  jobId: string,
  after: number,
  etag?: string,
): Promise<EventPollResult> {
  const headers = new Headers();
  if (etag) headers.set('if-none-match', etag);
  const response = await platformApiRawFetch(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/events/poll?after=${after}`,
    { headers },
  );
  if (response.status === 304) return { notModified: true, etag, items: [], nextCursor: after };
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new PlatformApiError(
      'EVENT_POLL_FAILED',
      `任务事件读取失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  const parsed = IngestionJobEventListEnvelopeSchema.parse(payload);
  return {
    notModified: false,
    etag: response.headers.get('etag') ?? undefined,
    items: parsed.data.items,
    nextCursor: parsed.data.nextCursor,
  };
}

/** XHR 暴露精确上传进度和 AbortController；成功返回对象存储 ETag。 */
export function putPresignedObject(
  url: string,
  blob: Blob,
  options: {
    readonly contentType?: string;
    readonly signal: AbortSignal;
    readonly onProgress: (uploadedBytes: number) => void;
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = (): void => xhr.abort();
    xhr.open('PUT', url, true);
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded);
    });
    xhr.addEventListener('load', () => {
      options.signal.removeEventListener('abort', abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.getResponseHeader('ETag') ?? '').replace(/^"|"$/g, ''));
      } else reject(new Error(`对象存储上传失败（HTTP ${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('对象存储连接失败')));
    xhr.addEventListener('abort', () => reject(new DOMException('上传已取消', 'AbortError')));
    options.signal.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}
