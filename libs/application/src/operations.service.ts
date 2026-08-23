/**
 * 平台总览、运维 Dashboard、Provider、告警、Flag 与审计查询用例。
 *
 * 服务执行角色门禁并组合多个 Port；不把密钥、连接串和完整异常暴露给 Controller。
 * 导出使用相同白名单查询并限制最多一万条，防止一次请求拖垮数据库。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement OPS-018
 * @requirement WEB-006
 * @requirement WEB-024
 * @requirement WEB-025
 * @requirement WEB-026
 */
import type {
  AuditLogEntry,
  AuditLogQuery,
  FeatureFlag,
  OperationalComponent,
  OperationalAlert,
  OperationsDashboard,
  PlatformOverview,
  ProviderProfileStatus,
  UpdateFeatureFlagRequest,
  UpdateOperationalAlertRequest,
} from '@rag/contracts';
import { ApplicationError } from './application.error';
import type {
  AuditLogPage,
  OperationsRepository,
  ProviderOperationsPort,
  RuntimeOperationsPort,
} from './operations.ports';
import type { AccessContext } from './ports';

/** 运维控制面应用服务。 */
export class OperationsService {
  public constructor(
    private readonly repository: OperationsRepository,
    private readonly runtime: RuntimeOperationsPort,
    private readonly providers: ProviderOperationsPort,
  ) {}

  /** 总览允许知识管理员和系统管理员读取。 */
  public overview(context: AccessContext): Promise<PlatformOverview> {
    assertRole(context, ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN']);
    return this.repository.getOverview(context);
  }

  /** 运维 Dashboard 组合实时探针、队列和告警。 */
  public async dashboard(context: AccessContext): Promise<OperationsDashboard> {
    assertRole(context, ['SYSTEM_ADMIN', 'AUDITOR']);
    const [runtimeComponents, providerProfiles, queues, reconciliations, alerts] =
      await Promise.all([
        this.runtime.listComponents(),
        this.providers.listProviderProfiles(),
        this.repository.listQueues(context),
        this.repository.listReconciliations(context),
        this.repository.listAlerts(context),
      ]);
    const components = [
      ...runtimeComponents,
      ...providerProfiles.map((profile) => providerComponent(profile)),
    ];
    const overallStatus = components.some((item) => item.status === 'DOWN')
      ? 'DOWN'
      : components.some((item) => item.status === 'DEGRADED' || item.status === 'UNKNOWN')
        ? 'DEGRADED'
        : 'UP';
    // Zod 的公开契约使用普通数组，Port 则以 readonly 防止用例层误改；这里复制后再输出。
    return {
      generatedAt: new Date().toISOString(),
      overallStatus,
      components: [...components],
      queues: [...queues],
      reconciliations: [...reconciliations],
      alerts: [...alerts],
    };
  }

  /** Provider 响应永远只包含是否配置密钥，不包含密钥值。 */
  public providersStatus(context: AccessContext): Promise<readonly ProviderProfileStatus[]> {
    assertRole(context, ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN', 'AUDITOR']);
    return this.providers.listProviderProfiles();
  }

  /** 告警动作需要系统管理员。 */
  public acknowledgeAlert(
    context: AccessContext,
    alertId: string,
    request: UpdateOperationalAlertRequest,
  ): Promise<OperationalAlert> {
    assertRole(context, ['SYSTEM_ADMIN']);
    return this.repository.updateAlert(context, alertId, request.action, request.reason);
  }

  /** Flag 列表。 */
  public listFeatureFlags(context: AccessContext): Promise<readonly FeatureFlag[]> {
    assertRole(context, ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN', 'AUDITOR']);
    return this.repository.listFeatureFlags(context);
  }

  /** Flag 更新使用 scope + key 白名单定位，不能由客户端提交 SQL。 */
  public updateFeatureFlag(
    context: AccessContext,
    flagKey: string,
    spaceId: string | null,
    request: UpdateFeatureFlagRequest,
  ): Promise<FeatureFlag> {
    assertRole(context, ['SYSTEM_ADMIN']);
    return this.repository.updateFeatureFlag(context, flagKey, spaceId, request);
  }

  /** 审计分页。 */
  public auditLogs(context: AccessContext, query: AuditLogQuery): Promise<AuditLogPage> {
    assertRole(context, ['SYSTEM_ADMIN', 'AUDITOR']);
    return this.repository.listAuditLogs(context, query);
  }

  /** 审计导出返回脱敏行，由 HTTP Adapter 生成 CSV。 */
  public exportAudit(
    context: AccessContext,
    query: AuditLogQuery,
  ): Promise<readonly AuditLogEntry[]> {
    assertRole(context, ['SYSTEM_ADMIN', 'AUDITOR']);
    return this.repository.exportAuditLogs(context, { ...query, limit: 200 });
  }
}

/** 将脱敏 Provider/Profile 状态纳入统一 Dashboard，不复制密钥或完整 URL。 */
function providerComponent(profile: ProviderProfileStatus): OperationalComponent {
  return {
    key: `provider:${profile.capability.toLocaleLowerCase('en-US')}:${profile.profileId}`,
    label: `${profile.capability} / ${profile.profileId}`,
    kind: profile.capability === 'VECTOR_STORE' ? 'MILVUS' : 'MODEL',
    status: profile.health,
    latencyMs: null,
    message: profile.compatibilityMessage,
    checkedAt: new Date().toISOString(),
    metadata: {
      adapter: profile.adapter,
      revision: profile.revision,
      protocolVersion: profile.protocolVersion,
      endpointHost: profile.endpointHost,
      credentialConfigured: profile.credentialConfigured,
    },
  };
}

function assertRole(context: AccessContext, roles: readonly string[]): void {
  if (!context.user.roles.some((role) => roles.includes(role))) {
    throw new ApplicationError('ACCESS_DENIED', 403, '当前角色不能访问运维控制面');
  }
}
