/**
 * M04 运行详情、Chunk 游标与人工审核状态。
 * 可适配普通值、Ref 或 getter；切换任务时 generation 阻止旧请求覆盖新任务。
 *
 * @requirement KNO-011
 * @requirement KNO-012
 */
import type {
  DocumentQualityReport,
  KnowledgeChunk,
  KnowledgeProcessingRun,
  QualityFinding,
  ReviewQualityRequest,
} from '@rag/contracts';
import {
  shallowReadonly,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue';
import {
  getKnowledgeProcessingRun,
  listKnowledgeChunks,
  listKnowledgeProcessingRuns,
  reviewKnowledgeQuality,
} from '../services/documentIngestionApi';

/** M04 feature composable 的只读状态和显式动作。 */
export interface KnowledgeProcessingComposable {
  readonly runs: Readonly<ShallowRef<readonly KnowledgeProcessingRun[]>>;
  readonly selectedRun: Readonly<ShallowRef<KnowledgeProcessingRun | undefined>>;
  readonly report: Readonly<ShallowRef<DocumentQualityReport | undefined>>;
  readonly findings: Readonly<ShallowRef<readonly QualityFinding[]>>;
  readonly chunks: Readonly<ShallowRef<readonly KnowledgeChunk[]>>;
  readonly loading: Readonly<ShallowRef<boolean>>;
  readonly loadingMore: Readonly<ShallowRef<boolean>>;
  readonly submittingReview: Readonly<ShallowRef<boolean>>;
  readonly errorMessage: Readonly<ShallowRef<string>>;
  readonly reviewErrorMessage: Readonly<ShallowRef<string>>;
  readonly nextOrdinal: Readonly<ShallowRef<number | null>>;
  readonly lastReprocessJobId: Readonly<ShallowRef<string | null>>;
  reload: () => Promise<void>;
  selectRun: (run: KnowledgeProcessingRun) => Promise<void>;
  loadMore: () => Promise<void>;
  submitReview: (request: ReviewQualityRequest) => Promise<boolean>;
}

/** 创建 M04 管理端状态容器。 */
export function useKnowledgeProcessing(
  documentVersionId: MaybeRefOrGetter<string | undefined>,
): KnowledgeProcessingComposable {
  const runs = shallowRef<readonly KnowledgeProcessingRun[]>([]);
  const selectedRun = shallowRef<KnowledgeProcessingRun>();
  const report = shallowRef<DocumentQualityReport>();
  const findings = shallowRef<readonly QualityFinding[]>([]);
  const chunks = shallowRef<readonly KnowledgeChunk[]>([]);
  const loading = shallowRef(false);
  const loadingMore = shallowRef(false);
  const submittingReview = shallowRef(false);
  const errorMessage = shallowRef('');
  const reviewErrorMessage = shallowRef('');
  const nextOrdinal = shallowRef<number | null>(null);
  const lastReprocessJobId = shallowRef<string | null>(null);
  let requestGeneration = 0;

  async function reload(): Promise<void> {
    const versionId = toValue(documentVersionId);
    const generation = ++requestGeneration;
    if (!versionId) {
      reset();
      return;
    }
    loading.value = true;
    try {
      const loadedRuns = await listKnowledgeProcessingRuns(versionId);
      if (generation !== requestGeneration) return;
      runs.value = loadedRuns;
      const first = loadedRuns[0];
      if (first) await loadRun(first, generation);
      else resetDetail();
      errorMessage.value = '';
    } catch (error: unknown) {
      if (generation === requestGeneration) errorMessage.value = publicError(error);
    } finally {
      if (generation === requestGeneration) loading.value = false;
    }
  }

  async function selectRun(run: KnowledgeProcessingRun): Promise<void> {
    const generation = ++requestGeneration;
    loading.value = true;
    try {
      await loadRun(run, generation);
      errorMessage.value = '';
    } catch (error: unknown) {
      if (generation === requestGeneration) errorMessage.value = publicError(error);
    } finally {
      if (generation === requestGeneration) loading.value = false;
    }
  }

  async function loadRun(run: KnowledgeProcessingRun, generation: number): Promise<void> {
    const [detail, chunkPage] = await Promise.all([
      getKnowledgeProcessingRun(run.id),
      listKnowledgeChunks(run.id),
    ]);
    if (generation !== requestGeneration) return;
    selectedRun.value = detail.run;
    report.value = detail.report;
    findings.value = detail.findings;
    chunks.value = chunkPage.items;
    nextOrdinal.value = chunkPage.nextOrdinal;
    reviewErrorMessage.value = '';
    lastReprocessJobId.value = null;
  }

  async function loadMore(): Promise<void> {
    const run = selectedRun.value;
    const cursor = nextOrdinal.value;
    if (!run || cursor === null || loadingMore.value) return;
    loadingMore.value = true;
    try {
      const page = await listKnowledgeChunks(run.id, cursor);
      const known = new Set(chunks.value.map((chunk) => chunk.id));
      chunks.value = [...chunks.value, ...page.items.filter((chunk) => !known.has(chunk.id))];
      nextOrdinal.value = page.nextOrdinal;
      errorMessage.value = '';
    } catch (error: unknown) {
      errorMessage.value = publicError(error);
    } finally {
      loadingMore.value = false;
    }
  }

  async function submitReview(request: ReviewQualityRequest): Promise<boolean> {
    const run = selectedRun.value;
    if (!run || submittingReview.value) return false;
    submittingReview.value = true;
    try {
      const result = await reviewKnowledgeQuality(run.id, request);
      report.value = result.report;
      lastReprocessJobId.value = result.reprocessJobId;
      reviewErrorMessage.value = '';
      await reload();
      return true;
    } catch (error: unknown) {
      reviewErrorMessage.value = publicReviewError(error);
      return false;
    } finally {
      submittingReview.value = false;
    }
  }

  function resetDetail(): void {
    selectedRun.value = undefined;
    report.value = undefined;
    findings.value = [];
    chunks.value = [];
    nextOrdinal.value = null;
    reviewErrorMessage.value = '';
    lastReprocessJobId.value = null;
  }

  function reset(): void {
    runs.value = [];
    resetDetail();
    errorMessage.value = '';
    loading.value = false;
  }

  watch(
    () => toValue(documentVersionId),
    () => void reload(),
    { immediate: true },
  );

  return {
    runs: shallowReadonly(runs),
    selectedRun: shallowReadonly(selectedRun),
    report: shallowReadonly(report),
    findings: shallowReadonly(findings),
    chunks: shallowReadonly(chunks),
    loading: shallowReadonly(loading),
    loadingMore: shallowReadonly(loadingMore),
    submittingReview: shallowReadonly(submittingReview),
    errorMessage: shallowReadonly(errorMessage),
    reviewErrorMessage: shallowReadonly(reviewErrorMessage),
    nextOrdinal: shallowReadonly(nextOrdinal),
    lastReprocessJobId: shallowReadonly(lastReprocessJobId),
    reload,
    selectRun,
    loadMore,
    submitReview,
  };
}

function publicError(error: unknown): string {
  if (hasStatus(error, 403)) return '当前身份无权查看知识加工详情';
  return error instanceof Error ? error.message : '知识加工详情加载失败';
}

function publicReviewError(error: unknown): string {
  if (hasStatus(error, 403)) return '当前身份缺少内容审核权限';
  if (hasStatus(error, 409)) return '报告已变化或当前状态不可审核，请关闭后重新加载';
  return error instanceof Error ? error.message : '质量审核提交失败';
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' && error !== null && 'status' in error && error.status === status
  );
}
