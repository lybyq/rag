/**
 * M06 Run 应用服务降级单元门禁。
 * Redis 是事件投影而非业务事实源；读取失败时仍必须返回 PG Run，且终态提示客户端改用轮询。
 *
 * @requirement RUN-009
 */
import type { RagRun } from '@rag/contracts';
import { createTestUserContext } from '@rag/testing';
import type { AuthorizationService } from './authorization.service';
import type { AccessContext } from './ports';
import type {
  RagRunCancellationPort,
  RagRunEventStreamPort,
  RagRunRepository,
  SensitiveTextProtectorPort,
} from './rag-run.ports';
import { RagRunService } from './rag-run.service';

describe('[RUN-009] RagRunService stream fallback', () => {
  test('Redis 读取失败时保留 PG 终态并标记 Stream 降级', async () => {
    const run = completedRun();
    const repository = {
      getRun: jest.fn().mockResolvedValue(run),
    } as unknown as RagRunRepository;
    const stream = {
      read: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RagRunEventStreamPort;
    const service = new RagRunService(
      repository,
      {} as AuthorizationService,
      {} as SensitiveTextProtectorPort,
      stream,
      {} as RagRunCancellationPort,
      {
        flowVersion: 'flow-v1',
        policyVersion: 'policy-v1',
        promptProfileId: 'prompt-v1',
        validatorProfileId: 'validator-v1',
        embeddingProfileId: 'embedding-v1',
        embeddingRevision: '1',
        rerankerProfileId: 'reranker-v1',
        rerankerRevision: '1',
        llmProfileId: 'llm-v1',
        llmRevision: '1',
        deadlineSeconds: 120,
        eventRetentionSeconds: 600,
        contentRetentionDays: 30,
        streamTicketTtlSeconds: 60,
        shortWindowMessages: 20,
      },
    );

    await expect(service.listEvents(context(), run.id, 4, 100)).resolves.toEqual({
      items: [],
      nextSequence: 4,
      streamExpired: true,
      run,
    });
  });
});

function context(): AccessContext {
  return {
    user: createTestUserContext('m06-unit-user', ['KNOWLEDGE_READER']),
    requestId: 'm06-unit-request',
  };
}

function completedRun(): RagRun {
  const now = '2026-08-23T00:00:00.000Z';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    conversationId: '00000000-0000-4000-8000-000000000002',
    userMessageId: '00000000-0000-4000-8000-000000000003',
    assistantMessageId: '00000000-0000-4000-8000-000000000004',
    status: 'COMPLETED',
    optimisticVersion: 2,
    snapshot: {
      flowVersion: 'flow-v1',
      policyVersion: 'policy-v1',
      promptProfileId: 'prompt-v1',
      embeddingProfileId: 'embedding-v1',
      embeddingRevision: '1',
      rerankerProfileId: 'reranker-v1',
      rerankerRevision: '1',
      llmProfileId: 'llm-v1',
      llmRevision: '1',
      validatorProfileId: 'validator-v1',
      manifests: [
        {
          spaceId: '00000000-0000-4000-8000-000000000005',
          manifestId: '00000000-0000-4000-8000-000000000006',
          manifestVersion: 1,
          embeddingProfileId: 'embedding-v1',
          embeddingModelRevision: '1',
          collectionName: 'rag_chunks_unit',
          authzPolicyVersion: 1,
        },
      ],
      authzVersion: 1,
      rolesSha256: 'a'.repeat(64),
    },
    deadlineAt: now,
    eventExpiresAt: '2099-08-23T00:00:00.000Z',
    cancelRequestedAt: null,
    failureCode: null,
    publicMessage: '回答已完成',
    createdAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}
