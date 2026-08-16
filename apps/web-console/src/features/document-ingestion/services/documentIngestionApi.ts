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
  type CompleteUploadRequest,
  type CompleteUploadResult,
  type CreateUploadPartsRequest,
  type CreateUploadSessionRequest,
  type CursorPage,
  type Document,
  type IngestionExecutionStatus,
  type IngestionJob,
  type IngestionJobEvent,
  type UploadPartInstruction,
  type UploadSession,
} from '@rag/contracts';
import {
  PlatformApiError,
  platformApiFetch,
  platformApiRawFetch,
} from '../../identity/services/platformApi';

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
