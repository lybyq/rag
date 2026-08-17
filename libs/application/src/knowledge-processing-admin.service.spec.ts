/** M04 审核权限和乐观锁命令传播测试。 @requirement KNO-011 @requirement KNO-012 */
import type { KnowledgeProcessingRepository } from './knowledge-processing.ports';
import { KnowledgeProcessingAdminService } from './knowledge-processing-admin.service';
import type { AccessContext } from './ports';
import { createTestUserContext } from '@rag/testing';

const context: AccessContext = {
  user: createTestUserContext('reviewer-1', ['KNOWLEDGE_REVIEWER']),
  requestId: 'request-1',
};

describe('[KNO-011][KNO-012] KnowledgeProcessingAdminService', () => {
  it('审核前必须按服务端资源映射要求 REVIEW 权限，并传递 expectedVersion', async () => {
    const repository = {
      review: jest.fn().mockResolvedValue({ report: {}, reprocessJobId: null }),
    } as unknown as jest.Mocked<KnowledgeProcessingRepository>;
    const authorization = { requireResourcePermission: jest.fn().mockResolvedValue('space-1') };
    const service = new KnowledgeProcessingAdminService(repository, authorization);

    await service.review(context, '33333333-3333-4333-8333-333333333333', {
      action: 'APPROVE',
      expectedVersion: 3,
      reason: '已逐页核对原文',
    });

    expect(authorization.requireResourcePermission).toHaveBeenCalledWith(
      context,
      'KNOWLEDGE_RUN',
      '33333333-3333-4333-8333-333333333333',
      'REVIEW',
    );
    expect(repository.review).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3, action: 'APPROVE' }),
    );
  });

  it('权限拒绝时绝不执行审核事务', async () => {
    const repository = {
      review: jest.fn(),
    } as unknown as jest.Mocked<KnowledgeProcessingRepository>;
    const authorization = {
      requireResourcePermission: jest.fn().mockRejectedValue(new Error('ACCESS_DENIED')),
    };
    const service = new KnowledgeProcessingAdminService(repository, authorization);

    await expect(
      service.review(context, '33333333-3333-4333-8333-333333333333', {
        action: 'REJECT',
        expectedVersion: 1,
        reason: '质量不足',
      }),
    ).rejects.toThrow('ACCESS_DENIED');
    expect(repository.review).not.toHaveBeenCalled();
  });
});
