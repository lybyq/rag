/**
 * 运维控制面应用服务测试：验证角色默认拒绝，并确保运行时、Provider、队列、对账和告警完整聚合。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement WEB-025
 */
import { createTestUserContext } from '@rag/testing';
import type { OperationalComponent, SemanticRole } from '@rag/contracts';
import type {
  OperationsRepository,
  ProviderOperationsPort,
  RuntimeOperationsPort,
} from './operations.ports';
import { OperationsService } from './operations.service';
import type { AccessContext } from './ports';

const now = '2026-08-23T00:00:00.000Z';

describe('[OPS-005] OperationsService', () => {
  it('聚合依赖、Provider、队列、索引对账和告警，并按最差组件计算总状态', async () => {
    const repository = {
      listQueues: jest.fn(async () => [
        {
          queue: 'rag-online',
          waiting: 1,
          active: 2,
          delayed: 0,
          failed: 0,
          dlq: 0,
          stalled: 0,
          oldestWaitingSeconds: 3,
        },
      ]),
      listReconciliations: jest.fn(async () => [
        {
          id: '00000000-0000-4000-8000-000000000001',
          indexingRunId: '00000000-0000-4000-8000-000000000002',
          manifestId: '00000000-0000-4000-8000-000000000003',
          expectedCount: 10,
          actualCount: 10,
          checkedPrimaryKeys: 10,
          fixedQueriesPassed: 3,
          issueCount: 0,
          passed: true,
          reportSha256: 'a'.repeat(64),
          createdAt: now,
        },
      ]),
      listAlerts: jest.fn(async () => []),
    } as unknown as OperationsRepository;
    const runtime = {
      listComponents: jest.fn(async () => [component('postgres', 'POSTGRES', 'UP')]),
    } as RuntimeOperationsPort;
    const providers = {
      listProviderProfiles: jest.fn(async () => [
        {
          capability: 'LLM' as const,
          adapter: 'openai-compatible',
          profileId: 'llm-primary',
          modelId: 'deepseek-chat',
          revision: 'v1',
          protocolVersion: 'openai-v1',
          endpointHost: 'models.internal',
          credentialConfigured: true,
          health: 'DEGRADED' as const,
          compatibilityMessage: '探针延迟升高',
        },
      ]),
    } as ProviderOperationsPort;
    const service = new OperationsService(repository, runtime, providers);

    const result = await service.dashboard(context(['SYSTEM_ADMIN']));

    expect(result.overallStatus).toBe('DEGRADED');
    expect(result.components.map((item) => item.key)).toEqual([
      'postgres',
      'provider:llm:llm-primary',
    ]);
    expect(result.queues).toHaveLength(1);
    expect(result.reconciliations[0]).toMatchObject({ passed: true, actualCount: 10 });
  });

  it('普通用户默认拒绝读取运维控制面', async () => {
    const repository = { listQueues: jest.fn() } as unknown as OperationsRepository;
    const service = new OperationsService(
      repository,
      { listComponents: jest.fn() } as unknown as RuntimeOperationsPort,
      { listProviderProfiles: jest.fn() } as unknown as ProviderOperationsPort,
    );

    await expect(service.dashboard(context(['KNOWLEDGE_READER']))).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      httpStatus: 403,
    });
    expect(repository.listQueues).not.toHaveBeenCalled();
  });
});

function context(roles: readonly SemanticRole[]): AccessContext {
  return { user: createTestUserContext('operator', roles), requestId: 'request-ops' };
}

function component(key: string, kind: 'POSTGRES', status: 'UP'): OperationalComponent {
  return {
    key,
    label: key,
    kind,
    status,
    latencyMs: 2,
    message: 'ready',
    checkedAt: now,
    metadata: {},
  };
}
