/**
 * 总览、评测、运维、配置和审计页面的状态与副作用集合。
 * Route View 与展示组件不直接执行 fetch；所有失败都保留可重试状态。
 *
 * @requirement WEB-006 WEB-023 WEB-024 WEB-025 WEB-026 WEB-027
 */
import type {
  AuditLogEntry,
  AuditLogQuery,
  EvaluationDataset,
  EvaluationRun,
  EvaluationRunDetail,
  FeatureFlag,
  OperationsDashboard,
  PlatformOverview,
  ProviderProfileStatus,
} from '@rag/contracts';
import { onMounted, reactive, shallowRef, type ShallowRef } from 'vue';
import {
  activateEvaluationDataset,
  createEvaluationRun,
  downloadAuditLogs,
  getAuditLogs,
  getEvaluationRun,
  getFeatureFlags,
  getOperationsDashboard,
  getPlatformOverview,
  getProviderProfiles,
  listEvaluationDatasets,
  listEvaluationRuns,
  updateFeatureFlag,
  updateOperationalAlert,
} from '../services/operationsApi';

/** 平台总览页面状态。 */
export interface PlatformOverviewComposable {
  readonly overview: ShallowRef<PlatformOverview | undefined>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly load: () => Promise<void>;
}

/** 运维 Dashboard 页面状态。 */
export interface OperationsDashboardComposable {
  readonly dashboard: ShallowRef<OperationsDashboard | undefined>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly load: () => Promise<void>;
  readonly act: (alertId: string, action: 'ACKNOWLEDGE' | 'RESOLVE') => Promise<void>;
}

/** Provider 与 Feature Flag 页面状态。 */
export interface ProviderSettingsComposable {
  readonly providers: ShallowRef<readonly ProviderProfileStatus[]>;
  readonly flags: ShallowRef<readonly FeatureFlag[]>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly load: () => Promise<void>;
  readonly update: (
    flag: FeatureFlag,
    enabled: boolean,
    rollout: number,
    reason: string,
  ) => Promise<void>;
}

/** 评测中心页面状态。 */
export interface EvaluationCenterComposable {
  readonly datasets: ShallowRef<readonly EvaluationDataset[]>;
  readonly runs: ShallowRef<readonly EvaluationRun[]>;
  readonly detail: ShallowRef<EvaluationRunDetail | undefined>;
  readonly loading: ShallowRef<boolean>;
  readonly mutating: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly load: () => Promise<void>;
  readonly inspect: (runId: string) => Promise<void>;
  readonly run: (datasetId: string) => Promise<void>;
  readonly activate: (datasetId: string) => Promise<void>;
}

/** 审计查询、游标和导出状态。 */
export interface AuditConsoleComposable {
  readonly items: ShallowRef<readonly AuditLogEntry[]>;
  readonly nextCursor: ShallowRef<string | null>;
  readonly loading: ShallowRef<boolean>;
  readonly errorMessage: ShallowRef<string>;
  readonly filters: AuditLogQuery;
  readonly load: (append?: boolean) => Promise<void>;
  readonly exportCsv: () => Promise<void>;
}

/** 平台业务总览状态。 */
export function usePlatformOverview(): PlatformOverviewComposable {
  const overview = shallowRef<PlatformOverview>();
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  async function load(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      overview.value = await getPlatformOverview();
    } catch (error: unknown) {
      errorMessage.value = message(error, '总览加载失败');
    } finally {
      loading.value = false;
    }
  }
  onMounted(() => void load());
  return { overview, loading, errorMessage, load };
}

/** 运维 Dashboard 状态。 */
export function useOperationsDashboard(): OperationsDashboardComposable {
  const dashboard = shallowRef<OperationsDashboard>();
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  async function load(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      dashboard.value = await getOperationsDashboard();
    } catch (error: unknown) {
      errorMessage.value = message(error, '运维状态加载失败');
    } finally {
      loading.value = false;
    }
  }
  async function act(alertId: string, action: 'ACKNOWLEDGE' | 'RESOLVE'): Promise<void> {
    try {
      await updateOperationalAlert(alertId, action, '管理员在运维控制台执行处置');
      await load();
    } catch (error: unknown) {
      errorMessage.value = message(error, '告警处置失败');
    }
  }
  onMounted(() => void load());
  return { dashboard, loading, errorMessage, load, act };
}

/** Provider 与 Feature Flag 状态。 */
export function useProviderSettings(): ProviderSettingsComposable {
  const providers = shallowRef<readonly ProviderProfileStatus[]>([]);
  const flags = shallowRef<readonly FeatureFlag[]>([]);
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  async function load(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      [providers.value, flags.value] = await Promise.all([
        getProviderProfiles(),
        getFeatureFlags(),
      ]);
    } catch (error: unknown) {
      errorMessage.value = message(error, '系统配置加载失败');
    } finally {
      loading.value = false;
    }
  }
  async function update(
    flag: FeatureFlag,
    enabled: boolean,
    rollout: number,
    reason: string,
  ): Promise<void> {
    const next = await updateFeatureFlag(flag, enabled, rollout, reason);
    flags.value = flags.value.map((item) =>
      item.key === next.key && item.spaceId === next.spaceId ? next : item,
    );
  }
  onMounted(() => void load());
  return { providers, flags, loading, errorMessage, load, update };
}

/** 评测中心状态。 */
export function useEvaluationCenter(): EvaluationCenterComposable {
  const datasets = shallowRef<readonly EvaluationDataset[]>([]);
  const runs = shallowRef<readonly EvaluationRun[]>([]);
  const detail = shallowRef<EvaluationRunDetail>();
  const loading = shallowRef(false);
  const mutating = shallowRef(false);
  const errorMessage = shallowRef('');
  async function load(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      [datasets.value, runs.value] = await Promise.all([
        listEvaluationDatasets(),
        listEvaluationRuns(),
      ]);
    } catch (error: unknown) {
      errorMessage.value = message(error, '评测中心加载失败');
    } finally {
      loading.value = false;
    }
  }
  async function inspect(runId: string): Promise<void> {
    loading.value = true;
    try {
      detail.value = await getEvaluationRun(runId);
    } catch (error: unknown) {
      errorMessage.value = message(error, '评测详情加载失败');
    } finally {
      loading.value = false;
    }
  }
  async function run(datasetId: string): Promise<void> {
    mutating.value = true;
    try {
      await createEvaluationRun(datasetId);
      await load();
    } catch (error: unknown) {
      errorMessage.value = message(error, '评测运行创建失败');
    } finally {
      mutating.value = false;
    }
  }
  async function activate(datasetId: string): Promise<void> {
    mutating.value = true;
    try {
      await activateEvaluationDataset(datasetId);
      await load();
    } catch (error: unknown) {
      errorMessage.value = message(error, '评测集激活失败');
    } finally {
      mutating.value = false;
    }
  }
  onMounted(() => void load());
  return { datasets, runs, detail, loading, mutating, errorMessage, load, inspect, run, activate };
}

/** 审计检索与游标翻页状态。 */
export function useAuditConsole(): AuditConsoleComposable {
  const items = shallowRef<readonly AuditLogEntry[]>([]);
  const nextCursor = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  const filters = reactive<AuditLogQuery>({ limit: 50 });
  async function load(append = false): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      const page = await getAuditLogs({
        ...filters,
        ...(append && nextCursor.value ? { cursor: nextCursor.value } : {}),
      });
      items.value = append ? [...items.value, ...page.items] : page.items;
      nextCursor.value = page.nextCursor;
    } catch (error: unknown) {
      errorMessage.value = message(error, '审计日志加载失败');
    } finally {
      loading.value = false;
    }
  }
  async function exportCsv(): Promise<void> {
    try {
      await downloadAuditLogs(filters);
    } catch (error: unknown) {
      errorMessage.value = message(error, '审计导出失败');
    }
  }
  onMounted(() => void load());
  return { items, nextCursor, loading, errorMessage, filters, load, exportCsv };
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
