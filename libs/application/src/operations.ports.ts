/**
 * 生产运维控制面的应用层端口。
 *
 * PostgreSQL、健康探针和 Provider 配置都通过接口进入用例；浏览器不能直接读取环境变量、
 * Redis、Milvus 或模型服务。所有列表都有限制，修改操作携带乐观锁和审计原因。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement OPS-018
 */
import type {
  AuditLogEntry,
  AuditLogQuery,
  FeatureFlag,
  FeatureFlagDecision,
  IndexReconciliationSummary,
  OperationalAlert,
  OperationalComponent,
  PlatformOverview,
  ProviderProfileStatus,
  QueueOperationalSummary,
  UpdateFeatureFlagRequest,
  UserContext,
} from '@rag/contracts';
import type { AccessContext } from './ports';

/** 审计游标页。 */
export interface AuditLogPage {
  readonly items: readonly AuditLogEntry[];
  readonly nextCursor: string | null;
}

/** 运维与审计 PostgreSQL 事实源。 */
export interface OperationsRepository {
  getOverview(context: AccessContext): Promise<PlatformOverview>;
  listQueues(context: AccessContext): Promise<readonly QueueOperationalSummary[]>;
  listReconciliations(context: AccessContext): Promise<readonly IndexReconciliationSummary[]>;
  listAlerts(context: AccessContext): Promise<readonly OperationalAlert[]>;
  updateAlert(
    context: AccessContext,
    alertId: string,
    action: 'ACKNOWLEDGE' | 'RESOLVE',
    reason: string,
  ): Promise<OperationalAlert>;
  listFeatureFlags(context: AccessContext): Promise<readonly FeatureFlag[]>;
  updateFeatureFlag(
    context: AccessContext,
    flagKey: string,
    spaceId: string | null,
    request: UpdateFeatureFlagRequest,
  ): Promise<FeatureFlag>;
  resolveFeatureFlags(
    user: UserContext,
    spaceIds: readonly string[],
  ): Promise<readonly FeatureFlagDecision[]>;
  listAuditLogs(context: AccessContext, query: AuditLogQuery): Promise<AuditLogPage>;
  exportAuditLogs(context: AccessContext, query: AuditLogQuery): Promise<readonly AuditLogEntry[]>;
}

/** API/Worker/基础设施实时健康聚合端口。 */
export interface RuntimeOperationsPort {
  listComponents(): Promise<readonly OperationalComponent[]>;
}

/** Provider/Profile 的非敏感公开状态端口。 */
export interface ProviderOperationsPort {
  listProviderProfiles(): Promise<readonly ProviderProfileStatus[]>;
}

/** RagRunService 只依赖的最小 Flag 解析接口。 */
export interface FeatureFlagResolverPort {
  resolveFeatureFlags(
    user: UserContext,
    spaceIds: readonly string[],
  ): Promise<readonly FeatureFlagDecision[]>;
}

/** 依赖注入 Token。 */
export const OPERATIONS_REPOSITORY = Symbol('OPERATIONS_REPOSITORY');
/** 运行健康聚合 Token。 */
export const RUNTIME_OPERATIONS = Symbol('RUNTIME_OPERATIONS');
/** Provider 状态 Token。 */
export const PROVIDER_OPERATIONS = Symbol('PROVIDER_OPERATIONS');
/** Feature Flag 解析 Token。 */
export const FEATURE_FLAG_RESOLVER = Symbol('FEATURE_FLAG_RESOLVER');
