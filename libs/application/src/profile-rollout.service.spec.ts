/** IDX-016 Profile rollout 的配置错配与离线评测门禁单元测试。 */
import type { EmbeddingProfile } from '@rag/contracts';
import { ProfileRolloutService, type ProfileRolloutConfig } from './profile-rollout.service';
import type {
  EmbeddingPort,
  ProfileRebuildTask,
  ProfileRolloutRepository,
  VectorIndexPort,
} from './indexing.ports';

describe('[IDX-016] ProfileRolloutService', () => {
  it('请求 Profile 与当前内网配置不一致时直接进入人工处理', async () => {
    const repository = repositoryMock();
    const service = new ProfileRolloutService(
      repository,
      embeddingMock(),
      vectorMock(true),
      config(),
    );
    const mismatched = { ...task('BUILD'), embeddingProfileId: 'another-profile' };

    await expect(service.process(mismatched, 'worker')).resolves.toBe('MANUAL');
    expect(repository.prepareProfileRebuild).not.toHaveBeenCalled();
    expect(repository.failProfileRebuild).toHaveBeenCalledWith(
      mismatched.requestId,
      'worker',
      'PROFILE_MISMATCH',
      expect.any(String),
      expect.any(Number),
      true,
    );
  });

  it('候选向量固定查询未命中期望文档时保存脱敏报告且禁止发布', async () => {
    const repository = repositoryMock();
    const service = new ProfileRolloutService(
      repository,
      embeddingMock(),
      vectorMock(false),
      config(),
    );

    await expect(service.process(task('EVALUATE'), 'worker')).resolves.toBe('EVALUATION_FAILED');
    expect(repository.completeProfileEvaluation).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'worker',
      expect.objectContaining({ recall: 0, caseCount: 1, minimumRecall: 1 }),
      false,
    );
    expect(
      JSON.stringify((repository.completeProfileEvaluation as jest.Mock).mock.calls[0]?.[2]),
    ).not.toContain('合成评测问题');
  });
});

function profile(): EmbeddingProfile {
  return {
    profileId: 'profile-v2',
    providerProfile: 'external-ci',
    provider: 'fixture',
    modelId: 'embedding',
    revision: '2',
    protocolVersion: '1',
    tokenizerRevision: 'tok-2',
    denseDimension: 2,
    normalizeDense: true,
    sparseFormatVersion: null,
    documentTemplateVersion: 'doc-v2',
    queryTemplateVersion: 'query-v2',
    maxInputTokens: 512,
    maxBatchSize: 8,
  };
}

function config(): ProfileRolloutConfig {
  return {
    profile: profile(),
    requestTimeoutMs: 1_000,
    overallDeadlineMs: 5_000,
    maxCases: 10,
    evaluationTopK: 3,
    minimumRecall: 1,
    maxAttempts: 3,
    retryBaseDelayMs: 10,
  };
}

function task(action: ProfileRebuildTask['action']): ProfileRebuildTask {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    action,
    spaceId: '22222222-2222-4222-8222-222222222222',
    embeddingProfileId: 'profile-v2',
    mode: 'CANARY',
    canaryPercent: 20,
    attempts: 1,
  };
}

function repositoryMock(): ProfileRolloutRepository & Record<string, jest.Mock> {
  return {
    claimProfileRebuildTasks: jest.fn(async () => []),
    prepareProfileRebuild: jest.fn(async () => 'job'),
    loadProfileCandidate: jest.fn(async () => ({
      requestId: '11111111-1111-4111-8111-111111111111',
      manifest: {
        id: '33333333-3333-4333-8333-333333333333',
        spaceId: '22222222-2222-4222-8222-222222222222',
        version: 2,
        status: 'VERIFIED' as const,
        providerProfile: 'external-ci' as const,
        embeddingProfileId: 'profile-v2',
        embeddingModelId: 'embedding',
        embeddingModelRevision: '2',
        tokenizerRevision: 'tok-2',
        denseDimension: 2,
        normalizeDense: true,
        sparseFormatVersion: null,
        collectionName: 'rag_profile_v2',
        expectedVectorCount: 1,
        actualVectorCount: 1,
        reconciliationSha256: 'a'.repeat(64),
        activatedAt: null,
        createdAt: new Date().toISOString(),
      },
      cases: [
        {
          caseId: 'case-1',
          queryText: '合成评测问题',
          querySha256: 'b'.repeat(64),
          tokenCount: 5,
          expectedDocumentId: '44444444-4444-4444-8444-444444444444',
        },
      ],
    })),
    completeProfileEvaluation: jest.fn(async () => undefined),
    failProfileRebuild: jest.fn(async () => undefined),
  } as unknown as ProfileRolloutRepository & Record<string, jest.Mock>;
}

function embeddingMock(): EmbeddingPort {
  return {
    checkHealth: jest.fn(async () => undefined),
    getMetadata: jest.fn(async () => ({
      provider: 'fixture',
      modelId: 'embedding',
      revision: '2',
      protocolVersion: '1',
      tokenizerRevision: 'tok-2',
      denseDimension: 2,
      normalizeDense: true,
      sparseFormatVersion: null,
      maxInputTokens: 512,
      maxBatchSize: 8,
      capabilities: ['query', 'document', 'dense'] as ('query' | 'document' | 'dense' | 'sparse')[],
    })),
    embedDocuments: jest.fn(async () => ({ outputs: [], failures: [] })),
    embedQueries: jest.fn(async (inputs) => ({
      outputs: inputs.map((input) => ({
        itemId: input.itemId,
        contentSha256: input.contentSha256,
        dense: [1, 0],
        sparse: null,
        modelId: 'embedding',
        revision: '2',
      })),
      failures: [],
    })),
  };
}

function vectorMock(hit: boolean): VectorIndexPort {
  return {
    ensureProfileCollection: jest.fn(async () => undefined),
    upsertManifestRecords: jest.fn(async () => ({
      succeededVectorIds: [],
      retryableVectorIds: [],
      terminalVectorIds: [],
    })),
    listManifestRecordFacts: jest.fn(async () => []),
    lookupRecordIds: jest.fn(async () => []),
    searchManifestDense: jest.fn(async () =>
      hit
        ? [
            {
              vectorId: 'c'.repeat(64),
              documentId: '44444444-4444-4444-8444-444444444444',
              score: 1,
            },
          ]
        : [],
    ),
    deleteManifestRecords: jest.fn(async () => undefined),
  };
}
