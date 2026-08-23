/** @requirement OPS-001 @requirement OPS-003 @requirement OPS-004 */
import type { EvaluationRepository } from './evaluation.ports';
import { EvaluationService } from './evaluation.service';
import { createTestUserContext } from '@rag/testing';

describe('[OPS-001] EvaluationService', () => {
  it('创建运行时锁定 Provider、Flow、Manifest 与代码版本', async () => {
    const createRun = jest.fn(async (_context, command) => ({ id: 'run', ...command }));
    const repository = {
      resolveManifestIds: jest.fn(async () => ['00000000-0000-4000-8000-000000000090']),
      createRun,
    } as unknown as EvaluationRepository;
    const service = new EvaluationService(
      repository,
      {
        flowVersion: 'flow-v1',
        policyVersion: 'policy-v1',
        promptProfileId: 'prompt-v1',
        embeddingProfileId: 'embedding-v1',
        embeddingRevision: 'e1',
        rerankerProfileId: 'reranker-v1',
        rerankerRevision: 'r1',
        llmProfileId: 'llm-v1',
        llmRevision: 'l1',
        validatorProfileId: 'validator-v1',
      },
      { restrictRequestedSpaces: jest.fn(async (_context, ids) => ids) } as never,
    );
    const context = {
      user: createTestUserContext('admin', ['SYSTEM_ADMIN']),
      requestId: 'request-1',
    };
    await service.createRun(context, {
      datasetId: '00000000-0000-4000-8000-000000000001',
      codeVersion: 'commit-abc',
    });
    expect(createRun).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        snapshot: expect.objectContaining({
          codeVersion: 'commit-abc',
          manifestIds: ['00000000-0000-4000-8000-000000000090'],
          llmRevision: 'l1',
        }),
      }),
    );
  });
});
