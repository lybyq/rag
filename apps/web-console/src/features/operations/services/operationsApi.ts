/**
 * 平台总览、评测、运维、Provider、Flag 与审计的浏览器契约入口。
 * 所有返回值使用共享 Schema 校验；导出仍走已认证后端，浏览器不拼 SQL 或访问基础设施。
 *
 * @requirement WEB-006
 * @requirement WEB-023
 * @requirement WEB-024
 * @requirement WEB-025
 * @requirement WEB-026
 * @requirement WEB-030
 */
import {
  AuditLogPageSchema,
  EvaluationDatasetListSchema,
  EvaluationDatasetSchema,
  EvaluationRunDetailSchema,
  EvaluationRunListSchema,
  EvaluationRunSchema,
  FeatureFlagListSchema,
  FeatureFlagSchema,
  OperationsDashboardSchema,
  OperationalAlertSchema,
  PlatformOverviewSchema,
  ProviderProfileStatusListSchema,
  createApiEnvelopeSchema,
  type AuditLogEntry,
  type AuditLogQuery,
  type EvaluationDataset,
  type EvaluationRun,
  type EvaluationRunDetail,
  type FeatureFlag,
  type OperationsDashboard,
  type OperationalAlert,
  type PlatformOverview,
  type ProviderProfileStatus,
} from '@rag/contracts';
import { platformApiFetch, platformApiRawFetch } from '@/features/identity/services/platformApi';

const OverviewEnvelope = createApiEnvelopeSchema(PlatformOverviewSchema);
const DashboardEnvelope = createApiEnvelopeSchema(OperationsDashboardSchema);
const AlertEnvelope = createApiEnvelopeSchema(OperationalAlertSchema);
const ProviderEnvelope = createApiEnvelopeSchema(ProviderProfileStatusListSchema);
const FlagEnvelope = createApiEnvelopeSchema(FeatureFlagListSchema);
const OneFlagEnvelope = createApiEnvelopeSchema(FeatureFlagSchema);
const AuditEnvelope = createApiEnvelopeSchema(AuditLogPageSchema);
const DatasetListEnvelope = createApiEnvelopeSchema(EvaluationDatasetListSchema);
const DatasetEnvelope = createApiEnvelopeSchema(EvaluationDatasetSchema);
const RunListEnvelope = createApiEnvelopeSchema(EvaluationRunListSchema);
const RunEnvelope = createApiEnvelopeSchema(EvaluationRunSchema);
const RunDetailEnvelope = createApiEnvelopeSchema(EvaluationRunDetailSchema);

/** 业务总览。 */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  return (await platformApiFetch('/api/v1/platform/overview', OverviewEnvelope)).data;
}

/** 运维组件、队列和告警总览。 */
export async function getOperationsDashboard(): Promise<OperationsDashboard> {
  return (await platformApiFetch('/api/v1/operations/dashboard', DashboardEnvelope)).data;
}

/** 授权后的告警确认或解决动作。 */
export async function updateOperationalAlert(
  alertId: string,
  action: 'ACKNOWLEDGE' | 'RESOLVE',
  reason: string,
): Promise<OperationalAlert> {
  return (
    await platformApiFetch(`/api/v1/operations/alerts/${alertId}`, AlertEnvelope, {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    })
  ).data;
}

/** 读取脱敏 Provider/Profile 状态。 */
export async function getProviderProfiles(): Promise<readonly ProviderProfileStatus[]> {
  return (await platformApiFetch('/api/v1/operations/providers', ProviderEnvelope)).data.items;
}

/** 读取 Feature Flag。 */
export async function getFeatureFlags(): Promise<readonly FeatureFlag[]> {
  return (await platformApiFetch('/api/v1/operations/feature-flags', FlagEnvelope)).data.items;
}

/** 带乐观锁和原因更新 Flag。 */
export async function updateFeatureFlag(
  flag: FeatureFlag,
  enabled: boolean,
  rolloutPercent: number,
  reason: string,
): Promise<FeatureFlag> {
  const query = flag.spaceId ? `?spaceId=${encodeURIComponent(flag.spaceId)}` : '';
  return (
    await platformApiFetch(
      `/api/v1/operations/feature-flags/${flag.key}${query}`,
      OneFlagEnvelope,
      {
        method: 'PUT',
        body: JSON.stringify({ enabled, rolloutPercent, expectedVersion: flag.version, reason }),
      },
    )
  ).data;
}

/** 白名单审计查询。 */
export async function getAuditLogs(
  query: AuditLogQuery,
): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }> {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  }
  return (await platformApiFetch(`/api/v1/operations/audit?${parameters}`, AuditEnvelope)).data;
}

/** 下载服务端脱敏并防公式注入的 CSV。 */
export async function downloadAuditLogs(query: AuditLogQuery): Promise<void> {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  }
  const response = await platformApiRawFetch(`/api/v1/operations/audit/export?${parameters}`);
  if (!response.ok) throw new Error(`审计导出失败（HTTP ${response.status}）`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rag-audit-export.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/** 评测数据集列表。 */
export async function listEvaluationDatasets(): Promise<readonly EvaluationDataset[]> {
  return (await platformApiFetch('/api/v1/evaluation/datasets', DatasetListEnvelope)).data.items;
}

/** 激活不可变评测集版本。 */
export async function activateEvaluationDataset(datasetId: string): Promise<EvaluationDataset> {
  return (
    await platformApiFetch(`/api/v1/evaluation/datasets/${datasetId}/activate`, DatasetEnvelope, {
      method: 'POST',
    })
  ).data;
}

/** 评测运行列表。 */
export async function listEvaluationRuns(): Promise<readonly EvaluationRun[]> {
  return (await platformApiFetch('/api/v1/evaluation/runs', RunListEnvelope)).data.items;
}

/** 创建真实异步评测。 */
export async function createEvaluationRun(datasetId: string): Promise<EvaluationRun> {
  return (
    await platformApiFetch('/api/v1/evaluation/runs', RunEnvelope, {
      method: 'POST',
      body: JSON.stringify({ datasetId, codeVersion: 'working-tree' }),
    })
  ).data;
}

/** 指标、基线差异和失败样本。 */
export async function getEvaluationRun(runId: string): Promise<EvaluationRunDetail> {
  return (await platformApiFetch(`/api/v1/evaluation/runs/${runId}`, RunDetailEnvelope)).data;
}
