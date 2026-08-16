/** 任务中心状态、详情刷新与 ETag 事件轮询。 */
import type { IngestionExecutionStatus, IngestionJob, IngestionJobEvent } from '@rag/contracts';
import { onBeforeUnmount, onMounted, reactive, shallowRef, type ShallowRef } from 'vue';
import {
  cancelIngestionJob,
  getIngestionJob,
  listIngestionJobs,
  pollIngestionJobEvents,
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
  load: () => Promise<void>;
  select: (job: IngestionJob) => Promise<void>;
  closeDetail: () => void;
  cancel: (jobId: string, reason: string) => Promise<void>;
}

/** 每三秒从后端事实刷新；进度值不在浏览器自增。 */
export function useIngestionJobs(): IngestionJobsComposable {
  const jobs = shallowRef<readonly IngestionJob[]>([]);
  const selectedJob = shallowRef<IngestionJob>();
  const events = shallowRef<readonly IngestionJobEvent[]>([]);
  const filters = reactive<JobFilters>({ spaceId: '', status: '' });
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  let timer: number | undefined;
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
    selectedJob.value = job;
    events.value = [];
    eventCursor = 0;
    eventEtag = undefined;
    await refreshSelected(job.id);
  }

  function closeDetail(): void {
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

  async function cancel(jobId: string, reason: string): Promise<void> {
    selectedJob.value = await cancelIngestionJob(jobId, reason);
    await load();
  }

  onMounted(() => {
    void load();
    timer = window.setInterval(() => void load(), 3_000);
  });
  onBeforeUnmount(() => {
    if (timer !== undefined) window.clearInterval(timer);
  });
  return {
    jobs,
    selectedJob,
    events,
    filters,
    loading,
    errorMessage,
    load,
    select,
    closeDetail,
    cancel,
  };
}
