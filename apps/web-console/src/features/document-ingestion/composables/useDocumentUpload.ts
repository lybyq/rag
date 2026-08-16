/**
 * 浏览器直传编排 Composable。
 * 大文件切片、进度、取消和失败分片重试都在浏览器完成，Platform API 不接触文件字节。
 */
import type { CompleteUploadResult, UploadFilePlan, UploadSession } from '@rag/contracts';
import { computed, onMounted, shallowRef, type ComputedRef, type ShallowRef } from 'vue';
import {
  cancelUploadSession,
  completeUpload,
  createUploadParts,
  createUploadSession,
  getUploadSession,
  putPresignedObject,
} from '../services/documentIngestionApi';

type UploadEntryStatus =
  | 'READY'
  | 'PREPARING'
  | 'UPLOADING'
  | 'VERIFYING'
  | 'QUEUED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NEEDS_FILE';

/** 上传队列的一行；File 只存在内存中，刷新后必须由用户重新选择。 */
export interface UploadQueueEntry {
  readonly clientFileId: string;
  readonly file?: File;
  readonly fileId?: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly strategy?: 'SINGLE' | 'MULTIPART';
  readonly status: UploadEntryStatus;
  readonly progressPercent: number;
  readonly retryCount: number;
  readonly message: string;
  readonly result?: CompleteUploadResult;
}

export interface DocumentUploadComposable {
  entries: ShallowRef<readonly UploadQueueEntry[]>;
  session: ShallowRef<UploadSession | undefined>;
  busy: ShallowRef<boolean>;
  errorMessage: ShallowRef<string>;
  lastCreatedJobId: ShallowRef<string | undefined>;
  readyCount: ComputedRef<number>;
  addFiles: (files: FileList | readonly File[]) => void;
  removeEntry: (clientFileId: string) => void;
  start: (spaceId: string) => Promise<void>;
  retry: (clientFileId: string) => Promise<void>;
  cancelEntry: (clientFileId: string) => void;
  cancelSession: () => Promise<void>;
}

const recoveryStorageKey = 'rag.m02.active-upload';

/** 创建一个页面级上传协调器；每个文件持有独立 AbortController。 */
export function useDocumentUpload(): DocumentUploadComposable {
  const entries = shallowRef<readonly UploadQueueEntry[]>([]);
  const session = shallowRef<UploadSession>();
  const busy = shallowRef(false);
  const errorMessage = shallowRef('');
  const lastCreatedJobId = shallowRef<string>();
  const abortControllers = new Map<string, AbortController>();
  const readyCount = computed(
    () => entries.value.filter((entry) => entry.file && entry.status === 'READY').length,
  );

  function addFiles(files: FileList | readonly File[]): void {
    const existingKeys = new Set(
      entries.value.map((entry) => `${entry.fileName}:${entry.sizeBytes}`),
    );
    const additions = Array.from(files)
      .filter((file) => file.size > 0 && !existingKeys.has(`${file.name}:${file.size}`))
      .slice(0, Math.max(0, 100 - entries.value.length))
      .map<UploadQueueEntry>((file) => ({
        clientFileId: crypto.randomUUID(),
        file,
        fileName: file.name,
        sizeBytes: file.size,
        status: 'READY',
        progressPercent: 0,
        retryCount: 0,
        message: '等待上传',
      }));
    entries.value = [...entries.value, ...additions];
  }

  function removeEntry(clientFileId: string): void {
    if (busy.value) return;
    entries.value = entries.value.filter((entry) => entry.clientFileId !== clientFileId);
  }

  async function start(spaceId: string): Promise<void> {
    const candidates = entries.value.filter(
      (entry): entry is UploadQueueEntry & { file: File } =>
        Boolean(entry.file) && ['READY', 'FAILED'].includes(entry.status),
    );
    if (!spaceId || candidates.length === 0) return;
    busy.value = true;
    errorMessage.value = '';
    candidates.forEach((entry) =>
      updateEntry(entry.clientFileId, { status: 'PREPARING', message: '创建直传会话' }),
    );
    try {
      const created = await createUploadSession({
        spaceId,
        files: candidates.map((entry) => ({
          clientFileId: entry.clientFileId,
          originalFileName: entry.file.name,
          sizeBytes: entry.file.size,
          contentType: entry.file.type || 'application/octet-stream',
        })),
      });
      session.value = created;
      persistRecovery(created);
      for (const plan of created.files) {
        updateEntry(plan.clientFileId, {
          fileId: plan.fileId,
          strategy: plan.strategy,
          message: plan.strategy === 'MULTIPART' ? `${plan.partCount} 个分片` : '浏览器直传',
        });
      }
      await runWithConcurrency(candidates, 3, async (entry) => {
        if (findEntry(entry.clientFileId)?.status === 'CANCELLED') return;
        const plan = created.files.find((item) => item.clientFileId === entry.clientFileId);
        if (!plan) {
          updateEntry(entry.clientFileId, { status: 'FAILED', message: '服务端未返回文件计划' });
          return;
        }
        // 单个文件失败只影响自己；同批其他文件继续完成，不让 Promise.all 提前结束。
        await uploadEntry(created.id, entry, plan).catch(() => undefined);
      });
    } catch (error: unknown) {
      errorMessage.value = messageOf(error, '上传会话创建失败');
      candidates.forEach((entry) => {
        const current = findEntry(entry.clientFileId);
        if (current && !['QUEUED', 'CANCELLED'].includes(current.status)) {
          updateEntry(entry.clientFileId, { status: 'FAILED', message: errorMessage.value });
        }
      });
    } finally {
      busy.value = false;
    }
  }

  async function retry(clientFileId: string): Promise<void> {
    const entry = findEntry(clientFileId);
    const currentSession = session.value;
    if (!entry?.file || !entry.fileId || !currentSession) return;
    const refreshed = await getUploadSession(currentSession.id);
    session.value = refreshed;
    const plan = refreshed.files.find((item) => item.fileId === entry.fileId);
    if (!plan) return;
    updateEntry(clientFileId, {
      retryCount: entry.retryCount + 1,
      status: 'UPLOADING',
      message: '重新上传失败分片',
    });
    await uploadEntry(refreshed.id, { ...entry, file: entry.file }, plan).catch(
      (error: unknown) => {
        updateEntry(clientFileId, { status: 'FAILED', message: messageOf(error, '重试失败') });
      },
    );
  }

  function cancelEntry(clientFileId: string): void {
    abortControllers.get(clientFileId)?.abort();
    updateEntry(clientFileId, { status: 'CANCELLED', message: '已在浏览器取消' });
  }

  async function cancelCurrentSession(): Promise<void> {
    const current = session.value;
    if (!current) return;
    abortControllers.forEach((controller) => controller.abort());
    await cancelUploadSession(current.id);
    entries.value = entries.value.map((entry) =>
      ['QUEUED', 'CANCELLED'].includes(entry.status)
        ? entry
        : { ...entry, status: 'CANCELLED', message: '会话已取消' },
    );
    window.localStorage.removeItem(recoveryStorageKey);
  }

  async function uploadEntry(
    uploadId: string,
    entry: UploadQueueEntry & { file: File },
    plan: UploadFilePlan,
  ): Promise<void> {
    const controller = new AbortController();
    abortControllers.set(entry.clientFileId, controller);
    updateEntry(entry.clientFileId, { status: 'UPLOADING', progressPercent: 0, message: '上传中' });
    try {
      const parts =
        plan.strategy === 'SINGLE'
          ? await uploadSingle(entry, plan, controller.signal)
          : await uploadMultipart(uploadId, entry, plan, controller.signal);
      updateEntry(entry.clientFileId, {
        status: 'VERIFYING',
        progressPercent: 100,
        message: '服务端 HEAD 校验并创建任务',
      });
      const result = await completeUpload(uploadId, { fileId: plan.fileId, parts });
      updateEntry(entry.clientFileId, {
        status: 'QUEUED',
        progressPercent: 100,
        message: '已进入后端任务队列',
        result,
      });
      lastCreatedJobId.value = result.job.id;
      const refreshed = await getUploadSession(uploadId);
      session.value = refreshed;
      if (refreshed.status === 'COMPLETED') window.localStorage.removeItem(recoveryStorageKey);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      updateEntry(entry.clientFileId, { status: 'FAILED', message: messageOf(error, '上传失败') });
      throw error;
    } finally {
      abortControllers.delete(entry.clientFileId);
    }
  }

  async function uploadSingle(
    entry: UploadQueueEntry & { file: File },
    plan: UploadFilePlan,
    signal: AbortSignal,
  ): Promise<[]> {
    if (!plan.uploadUrl) throw new Error('单文件预签名 URL 缺失');
    await putPresignedObject(plan.uploadUrl, entry.file, {
      contentType: entry.file.type || 'application/octet-stream',
      signal,
      onProgress: (uploadedBytes) =>
        updateProgress(entry.clientFileId, uploadedBytes, entry.file.size),
    });
    return [];
  }

  async function uploadMultipart(
    uploadId: string,
    entry: UploadQueueEntry & { file: File },
    plan: UploadFilePlan,
    signal: AbortSignal,
  ): Promise<{ partNumber: number; etag: string }[]> {
    const partProgress = new Map<number, number>();
    const partNumbers = Array.from({ length: plan.partCount }, (_, index) => index + 1);
    const completed = await runWithConcurrency(partNumbers, 3, async (partNumber) => {
      const start = (partNumber - 1) * plan.partSizeBytes;
      const end = Math.min(entry.file.size, start + plan.partSizeBytes);
      const blob = entry.file.slice(start, end);
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const instruction = (
            await createUploadParts(uploadId, {
              fileId: plan.fileId,
              partNumbers: [partNumber],
            })
          )[0];
          if (!instruction) throw new Error('分片 URL 缺失');
          const etag = await putPresignedObject(instruction.uploadUrl, blob, {
            signal,
            onProgress: (uploadedBytes) => {
              partProgress.set(partNumber, uploadedBytes);
              const totalUploaded = [...partProgress.values()].reduce(
                (sum, value) => sum + value,
                0,
              );
              updateProgress(entry.clientFileId, totalUploaded, entry.file.size);
            },
          });
          if (!etag) throw new Error('对象存储未暴露 ETag，请检查 MinIO CORS');
          partProgress.set(partNumber, blob.size);
          return { partNumber, etag };
        } catch (error: unknown) {
          lastError = error;
          if (signal.aborted) throw error;
        }
      }
      throw lastError;
    });
    return completed.sort((left, right) => left.partNumber - right.partNumber);
  }

  function updateProgress(clientFileId: string, uploadedBytes: number, totalBytes: number): void {
    updateEntry(clientFileId, {
      progressPercent: Math.min(99, Math.round((uploadedBytes / totalBytes) * 100)),
      message: `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`,
    });
  }

  function updateEntry(clientFileId: string, patch: Partial<UploadQueueEntry>): void {
    entries.value = entries.value.map((entry) =>
      entry.clientFileId === clientFileId ? { ...entry, ...patch } : entry,
    );
  }

  function findEntry(clientFileId: string): UploadQueueEntry | undefined {
    return entries.value.find((entry) => entry.clientFileId === clientFileId);
  }

  function persistRecovery(value: UploadSession): void {
    window.localStorage.setItem(recoveryStorageKey, JSON.stringify({ uploadId: value.id }));
  }

  async function restore(): Promise<void> {
    const raw = window.localStorage.getItem(recoveryStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { uploadId?: unknown };
      if (typeof parsed.uploadId !== 'string') return;
      const restored = await getUploadSession(parsed.uploadId);
      session.value = restored;
      entries.value = restored.files.map((plan) => ({
        clientFileId: plan.clientFileId,
        fileId: plan.fileId,
        fileName: plan.originalFileName,
        sizeBytes: plan.sizeBytes,
        strategy: plan.strategy,
        status: plan.completed ? 'QUEUED' : 'NEEDS_FILE',
        progressPercent: plan.completed ? 100 : 0,
        retryCount: 0,
        message: plan.completed ? '上传已完成，请在任务中心查看' : '会话已恢复，请重新选择原文件',
      }));
      if (restored.status !== 'ACTIVE') window.localStorage.removeItem(recoveryStorageKey);
    } catch {
      window.localStorage.removeItem(recoveryStorageKey);
    }
  }

  onMounted(() => void restore());
  return {
    entries,
    session,
    busy,
    errorMessage,
    lastCreatedJobId,
    readyCount,
    addFiles,
    removeEntry,
    start,
    retry,
    cancelEntry,
    cancelSession: cancelCurrentSession,
  };
}

/** 固定并发池防止 100 文件/大量分片同时占满浏览器连接。 */
async function runWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
