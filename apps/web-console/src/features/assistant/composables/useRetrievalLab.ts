/** 检索测试台状态；只接受稳定 Run ID，不允许浏览器提交 Milvus Filter。 @requirement WEB-017 */
import type { RagRunStep, RetrievalDebugResult } from '@rag/contracts';
import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue';
import { listRunSteps, runRetrievalDebug } from '../services/ragQueryApi';

/** 授权检索实验台。 */
export interface RetrievalLabComposable {
  readonly runId: ShallowRef<string>;
  readonly result: ShallowRef<RetrievalDebugResult | undefined>;
  readonly steps: ShallowRef<readonly RagRunStep[]>;
  readonly rerank: ComputedRef<RagRunStep | undefined>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly execute: () => Promise<void>;
}

/** 创建授权检索实验台状态。 */
export function useRetrievalLab(): RetrievalLabComposable {
  const runId = shallowRef('');
  const result = shallowRef<RetrievalDebugResult>();
  const steps = shallowRef<readonly RagRunStep[]>([]);
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  const rerank = computed(() => steps.value.find((step) => /rerank/i.test(step.nodeKey)));
  async function execute(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      [result.value, steps.value] = await Promise.all([
        runRetrievalDebug(runId.value),
        listRunSteps(runId.value),
      ]);
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '检索调试失败';
    } finally {
      loading.value = false;
    }
  }
  return { runId, result, steps, rerank, loading, errorMessage, execute };
}
