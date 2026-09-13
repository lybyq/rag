/** 任务中心状态、详情刷新与 ETag 事件轮询。 */
import type { IngestionExecutionStatus, IngestionJob, IngestionJobEvent } from '@rag/contracts';
import { onBeforeUnmount, onMounted, reactive, shallowRef, type ShallowRef } from 'vue';
import {
  cancelIngestionJob,
  getIngestionJob,
  listIngestionJobs,
  pollIngestionJobEvents,
  reprocessDocumentVersion,
  streamIngestionJobEvents,
} from '../services/documentIngestionApi';

export interface JobFilters {
  spaceId: string;
  status: '' | IngestionExecutionStatus;
}

export interface IngestionJobsComposable {
  jobs: ShallowRef<readonly IngestionJob[]>;
  selectedJob: ShallowRef<IngestionJob | undefined>;
  events: ShallowRef<readonly IngestionJobEvent[]>;
  filters: JobFilters;
  loading: ShallowRef<boolean>;
  errorMessage: ShallowRef<string>;
  streamMode: ShallowRef<'idle' | 'connecting' | 'sse' | 'polling'>;
  load: () => Promise<void>;
  select: (job: IngestionJob) => Promise<void>;
  selectById: (jobId: string) => Promise<void>;
  closeDetail: () => void;
  cancel: (jobId: string, reason: string) => Promise<void>;
  reprocess: (versionId: string, reason: string) => Promise<void>;
}

/** 每三秒从后端事实刷新；进度值不在浏览器自增。 */
export function useIngestionJobs(): IngestionJobsComposable {
  const jobs = shallowRef<readonly IngestionJob[]>([]);
  const selectedJob = shallowRef<IngestionJob>();
  const events = shallowRef<readonly IngestionJobEvent[]>([]);
  const filters = reactive<JobFilters>({ spaceId: '', status: '' });
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  const streamMode = shallowRef<'idle' | 'connecting' | 'sse' | 'polling'>('idle');
  let timer: number | undefined;
  let streamController: AbortController | undefined;
  let eventCursor = 0;
  let eventEtag: string | undefined;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const response = await listIngestionJobs({
        ...(filters.spaceId ? { spaceId: filters.spaceId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      });
      jobs.value = response.items;
      if (selectedJob.value) {
        await refreshSelected(selectedJob.value.id);
      }
      errorMessage.value = '';
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '任务加载失败';
    } finally {
      loading.value = false;
    }
  }

  async function select(job: IngestionJob): Promise<void> {
    streamController?.abort();
    selectedJob.value = job;
    events.value = [];
    eventCursor = 0;
    eventEtag = undefined;
    await refreshSelected(job.id);
    streamController = new AbortController();
    void maintainEventStream(job.id, streamController.signal);
  }

  /** 上传完成后用服务端返回的 jobId 直接打开真实任务链，不等待列表轮询碰巧刷新。 */
  async function selectById(jobId: string): Promise<void> {
    try {
      const job = await getIngestionJob(jobId);
      await select(job);
      errorMessage.value = '';
    } catch (error: unknown) {
      // 多文件上传会并行完成：某个任务短暂尚未可读时，只在任务中心显示错误，不能形成
      // 未处理的 Promise 拒绝并打断其他文件的上传/完成流程。
      errorMessage.value = error instanceof Error ? error.message : '任务详情加载失败';
    }
  }

  function closeDetail(): void {
    streamController?.abort();
    streamController = undefined;
    streamMode.value = 'idle';
    selectedJob.value = undefined;
    events.value = [];
    eventCursor = 0;
    eventEtag = undefined;
  }

  async function refreshSelected(jobId: string): Promise<void> {
    const [detail, eventPage] = await Promise.all([
      getIngestionJob(jobId),
      pollIngestionJobEvents(jobId, eventCursor, eventEtag),
    ]);
    selectedJob.value = detail;
    if (!eventPage.notModified) {
      const known = new Set(events.value.map((event) => event.id));
      events.value = [...events.value, ...eventPage.items.filter((event) => !known.has(event.id))];
      eventCursor = eventPage.nextCursor;
      eventEtag = eventPage.etag;
    }
  }

  /** SSE 为主；断线期间切换真实 ETag 轮询，随后携带 Last-Event-ID 重连。 */
  async function maintainEventStream(jobId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && selectedJob.value?.id === jobId) {
      streamMode.value = 'connecting';
      try {
        streamMode.value = 'sse';
        await streamIngestionJobEvents(jobId, eventCursor, signal, (event) => {
          if (event.id <= eventCursor) return;
          events.value = [...events.value, event];
          eventCursor = event.id;
          void getIngestionJob(jobId).then((job) => {
            selectedJob.value = job;
          });
        });
      } catch (error: unknown) {
        if (signal.aborted) return;
        errorMessage.value =
          error instanceof Error ? `${error.message}，已切换轮询` : 'SSE 断开，已切换轮询';
      }
      if (signal.aborted) return;
      streamMode.value = 'polling';
      await refreshSelected(jobId).catch(() => undefined);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
    }
  }

  async function cancel(jobId: string, reason: string): Promise<void> {
    selectedJob.value = await cancelIngestionJob(jobId, reason);
    await load();
  }

  async function reprocess(versionId: string, reason: string): Promise<void> {
    const job = await reprocessDocumentVersion(versionId, reason);
    await load();
    await select(job);
  }

  onMounted(() => {
    void load();
    timer = window.setInterval(() => void load(), 3_000);
  });
  onBeforeUnmount(() => {
    streamController?.abort();
    if (timer !== undefined) window.clearInterval(timer);
  });
  return {
    jobs,
    selectedJob,
    events,
    filters,
    loading,
    errorMessage,
    streamMode,
    load,
    select,
    selectById,
    closeDetail,
    cancel,
    reprocess,
  };
}
