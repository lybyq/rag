/** M06 会话与 Run 契约的正反例测试。 */
import { CreateRagRunRequestSchema, RagRunEventSchema, RagRunSnapshotSchema } from './rag-run';

describe('[RUN-003][RUN-004][RUN-007] rag run contracts', () => {
  test('Run 快照要求完整锁定 Provider 与 Manifest 版本', () => {
    expect(
      RagRunSnapshotSchema.safeParse({
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
            spaceId: '00000000-0000-4000-8000-000000000001',
            manifestId: '00000000-0000-4000-8000-000000000002',
            manifestVersion: 3,
            embeddingProfileId: 'embedding-v1',
            embeddingModelRevision: '1',
            collectionName: 'rag_chunks_abc',
            authzPolicyVersion: 5,
          },
        ],
        authzVersion: 7,
        rolesSha256: 'a'.repeat(64),
      }).success,
    ).toBe(true);
  });

  test('创建 Run 拒绝空问题和空空间', () => {
    expect(
      CreateRagRunRequestSchema.safeParse({ question: ' ', requestedSpaceIds: [] }).success,
    ).toBe(false);
  });

  test('事件 sequence 必须为正整数且类型不能注入换行', () => {
    const base = {
      eventId: '00000000-0000-4000-8000-000000000003',
      runId: '00000000-0000-4000-8000-000000000004',
      schemaVersion: 1,
      payload: {},
      occurredAt: '2026-08-22T00:00:00.000Z',
    };
    expect(
      RagRunEventSchema.safeParse({ ...base, sequence: 1, eventType: 'run.accepted' }).success,
    ).toBe(true);
    expect(
      RagRunEventSchema.safeParse({ ...base, sequence: 0, eventType: 'run\naccepted' }).success,
    ).toBe(false);
  });
});
