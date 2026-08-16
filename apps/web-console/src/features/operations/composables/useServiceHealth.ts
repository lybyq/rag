/**
 * 将四个进程的健康接口聚合为 UI 可直接消费的状态。
 * 组合式函数负责协议校验、超时和错误归一化，组件不处理 fetch 细节。
 */
import { ServiceHealthEnvelopeSchema } from '@rag/contracts';
import { computed, onMounted, shallowRef, type ComputedRef, type ShallowRef } from 'vue';

export type ServiceStatus = 'checking' | 'up' | 'down';

export interface ServiceHealthItem {
  key: string;
  name: string;
  role: string;
  endpoint: string;
  status: ServiceStatus;
  latencyMs?: number;
  message?: string;
}

/** `useServiceHealth` 对组件公开的最小响应式 API。 */
export interface ServiceHealthComposable {
  services: ShallowRef<ServiceHealthItem[]>;
  refreshing: ShallowRef<boolean>;
  availableCount: ComputedRef<number>;
  refresh: () => Promise<void>;
}

const serviceDefinitions = [
  {
    key: 'platform',
    name: 'Platform API',
    role: '管理面',
    endpoint: import.meta.env.VITE_PLATFORM_API_URL ?? '/api/v1/health/live',
  },
  {
    key: 'query',
    name: 'RAG Query',
    role: '在线问答',
    endpoint: import.meta.env.VITE_QUERY_API_URL ?? 'http://localhost:3001/api/v1/health/live',
  },
  {
    key: 'ingestion',
    name: 'Ingestion',
    role: '文档处理',
    endpoint:
      import.meta.env.VITE_INGESTION_PROBE_URL ?? 'http://localhost:3002/api/v1/health/live',
  },
  {
    key: 'scheduler',
    name: 'Scheduler',
    role: '任务调度',
    endpoint:
      import.meta.env.VITE_SCHEDULER_PROBE_URL ?? 'http://localhost:3003/api/v1/health/live',
  },
] as const;

/** 在给定时间内没有完成时主动中止网络请求。 */
async function fetchHealth(
  definition: (typeof serviceDefinitions)[number],
): Promise<ServiceHealthItem> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(definition.endpoint, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const envelope = ServiceHealthEnvelopeSchema.parse(await response.json());
    return {
      ...definition,
      status: envelope.data.status === 'up' ? 'up' : 'down',
      latencyMs: performance.now() - startedAt,
    };
  } catch (error: unknown) {
    return {
      ...definition,
      status: 'down',
      latencyMs: performance.now() - startedAt,
      message: error instanceof Error ? error.message : '健康检查失败',
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

/** 提供可重复刷新的四进程健康视图模型。 */
export function useServiceHealth(): ServiceHealthComposable {
  const services = shallowRef<ServiceHealthItem[]>(
    serviceDefinitions.map((definition) => ({ ...definition, status: 'checking' })),
  );
  const refreshing = shallowRef(false);
  const availableCount = computed(
    () => services.value.filter((item) => item.status === 'up').length,
  );

  async function refresh(): Promise<void> {
    if (refreshing.value) return;
    refreshing.value = true;
    services.value = services.value.map((item) => ({ ...item, status: 'checking' }));
    services.value = await Promise.all(serviceDefinitions.map(fetchHealth));
    refreshing.value = false;
  }

  onMounted(() => void refresh());
  return { services, refreshing, availableCount, refresh };
}
