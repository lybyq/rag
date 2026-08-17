/** M03 Parse Run 详情和 Block 游标分页状态。 */
import type { DocumentBlock, DocumentParseRun, ParseIssue } from '@rag/contracts';
import { toValue, watch, shallowRef, type MaybeRefOrGetter, type ShallowRef } from 'vue';
import {
  getDocumentParseRun,
  listDocumentBlocks,
  listDocumentParseRuns,
} from '../services/documentIngestionApi';

export interface ParseRunsComposable {
  runs: ShallowRef<readonly DocumentParseRun[]>;
  selectedRun: ShallowRef<DocumentParseRun | undefined>;
  issues: ShallowRef<readonly ParseIssue[]>;
  blocks: ShallowRef<readonly DocumentBlock[]>;
  loading: ShallowRef<boolean>;
  loadingMore: ShallowRef<boolean>;
  errorMessage: ShallowRef<string>;
  nextOrdinal: ShallowRef<number | null>;
  reload: () => Promise<void>;
  selectRun: (run: DocumentParseRun) => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * 接受普通值、Ref 或 getter；切换任务时 watch 会取消旧结果提交并重置游标。
 * @requirement PAR-015
 */
export function useParseRuns(
  documentVersionId: MaybeRefOrGetter<string | undefined>,
): ParseRunsComposable {
  const runs = shallowRef<readonly DocumentParseRun[]>([]);
  const selectedRun = shallowRef<DocumentParseRun>();
  const issues = shallowRef<readonly ParseIssue[]>([]);
  const blocks = shallowRef<readonly DocumentBlock[]>([]);
  const loading = shallowRef(false);
  const loadingMore = shallowRef(false);
  const errorMessage = shallowRef('');
  const nextOrdinal = shallowRef<number | null>(null);
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
      const loadedRuns = await listDocumentParseRuns(versionId);
      if (generation !== requestGeneration) return;
      runs.value = loadedRuns;
      const first = loadedRuns[0];
      if (first) await loadRun(first, generation);
      else resetDetail();
      errorMessage.value = '';
    } catch (error: unknown) {
      if (generation !== requestGeneration) return;
      errorMessage.value = publicError(error);
    } finally {
      if (generation === requestGeneration) loading.value = false;
    }
  }

  async function selectRun(run: DocumentParseRun): Promise<void> {
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

  async function loadRun(run: DocumentParseRun, generation: number): Promise<void> {
    const [detail, blockPage] = await Promise.all([
      getDocumentParseRun(run.id),
      listDocumentBlocks(run.id),
    ]);
    if (generation !== requestGeneration) return;
    selectedRun.value = detail.run;
    issues.value = detail.issues;
    blocks.value = blockPage.items;
    nextOrdinal.value = blockPage.nextOrdinal;
  }

  async function loadMore(): Promise<void> {
    const run = selectedRun.value;
    const cursor = nextOrdinal.value;
    if (!run || cursor === null || loadingMore.value) return;
    loadingMore.value = true;
    try {
      const page = await listDocumentBlocks(run.id, cursor);
      const known = new Set(blocks.value.map((block) => block.id));
      blocks.value = [...blocks.value, ...page.items.filter((block) => !known.has(block.id))];
      nextOrdinal.value = page.nextOrdinal;
      errorMessage.value = '';
    } catch (error: unknown) {
      errorMessage.value = publicError(error);
    } finally {
      loadingMore.value = false;
    }
  }

  function resetDetail(): void {
    selectedRun.value = undefined;
    issues.value = [];
    blocks.value = [];
    nextOrdinal.value = null;
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
    runs,
    selectedRun,
    issues,
    blocks,
    loading,
    loadingMore,
    errorMessage,
    nextOrdinal,
    reload,
    selectRun,
    loadMore,
  };
}

function publicError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) {
    return '当前身份无权查看解析详情';
  }
  return error instanceof Error ? error.message : '解析详情加载失败';
}
