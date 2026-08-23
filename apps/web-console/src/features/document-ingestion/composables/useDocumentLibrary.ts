/**
 * 文档库的服务端筛选、稳定游标、详情版本和有限并发批量重处理编排。
 * 批量命令保留逐项结果，不因一个文档失败丢弃其他成功事实。
 *
 * @requirement WEB-009
 * @requirement WEB-015
 * @requirement NFR-005
 */
import type { Document, DocumentVersion } from '@rag/contracts';
import { onMounted, reactive, shallowRef, type ShallowRef } from 'vue';
import {
  getDocument,
  listDocuments,
  reprocessDocumentVersion,
} from '../services/documentIngestionApi';

/** 文档库查询条件。 */
export interface DocumentLibraryFilters {
  spaceId: string;
  status: '' | 'ACTIVE' | 'ARCHIVED';
  search: string;
  contentType: string;
  latestVersionNumber: number | undefined;
  sort: 'UPDATED_DESC' | 'UPDATED_ASC';
}

/** 文档库页面状态。 */
export interface DocumentLibraryComposable {
  readonly items: ShallowRef<readonly Document[]>;
  readonly selected: ShallowRef<readonly Document[]>;
  readonly detail: ShallowRef<
    { document: Document; versions: readonly DocumentVersion[] } | undefined
  >;
  readonly nextCursor: ShallowRef<string | null>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly batchMessage: ShallowRef<string>;
  readonly filters: DocumentLibraryFilters;
  readonly load: (append?: boolean) => Promise<void>;
  readonly inspect: (documentId: string) => Promise<void>;
  readonly batchReprocess: (reason: string) => Promise<void>;
}

/** 创建文档库查询、详情和批处理状态。 */
export function useDocumentLibrary(): DocumentLibraryComposable {
  const items = shallowRef<readonly Document[]>([]);
  const selected = shallowRef<readonly Document[]>([]);
  const detail = shallowRef<{ document: Document; versions: readonly DocumentVersion[] }>();
  const nextCursor = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  const batchMessage = shallowRef('');
  const filters = reactive<DocumentLibraryFilters>({
    spaceId: '',
    status: '',
    search: '',
    contentType: '',
    latestVersionNumber: undefined,
    sort: 'UPDATED_DESC',
  });

  async function load(append = false): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      const page = await listDocuments({
        ...(filters.spaceId ? { spaceId: filters.spaceId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
        ...(filters.contentType ? { contentType: filters.contentType } : {}),
        ...(filters.latestVersionNumber
          ? { latestVersionNumber: filters.latestVersionNumber }
          : {}),
        sort: filters.sort,
        ...(append && nextCursor.value ? { cursor: nextCursor.value } : {}),
      });
      items.value = append ? [...items.value, ...page.items] : page.items;
      nextCursor.value = page.page.nextCursor;
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '文档列表加载失败';
    } finally {
      loading.value = false;
    }
  }

  async function inspect(documentId: string): Promise<void> {
    loading.value = true;
    try {
      detail.value = await getDocument(documentId);
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '文档详情加载失败';
    } finally {
      loading.value = false;
    }
  }

  /** 每批最多三个并发，返回成功/失败计数供管理员决定是否继续。 */
  async function batchReprocess(reason: string): Promise<void> {
    const pending = [...selected.value];
    let succeeded = 0;
    let failed = 0;
    loading.value = true;
    while (pending.length > 0) {
      const batch = pending.splice(0, 3);
      const results = await Promise.allSettled(
        batch.map(async (document) => {
          const current = await getDocument(document.id);
          const latest = current.versions[0];
          if (!latest) throw new Error('没有可重处理版本');
          return reprocessDocumentVersion(latest.id, reason);
        }),
      );
      succeeded += results.filter((item) => item.status === 'fulfilled').length;
      failed += results.filter((item) => item.status === 'rejected').length;
    }
    batchMessage.value = `批量重处理完成：成功 ${succeeded}，失败 ${failed}`;
    loading.value = false;
    await load();
  }

  onMounted(() => void load());
  return {
    items,
    selected,
    detail,
    nextCursor,
    loading,
    errorMessage,
    batchMessage,
    filters,
    load,
    inspect,
    batchReprocess,
  };
}
