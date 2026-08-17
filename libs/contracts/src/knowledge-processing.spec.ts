/**
 * M04 公共契约的运行时校验测试。
 * 它证明 API、Worker 和持久化层会共同拒绝歧义关系与无理由审核，而不是只依赖 TypeScript 静态类型。
 * 本文件不测试分块算法或数据库事务。
 *
 * @requirement KNO-001
 * @requirement KNO-011
 * @requirement KNO-012
 */
import { ChunkRelationSchema, ReviewQualityRequestSchema } from './knowledge-processing';

const validRelation = {
  id: '11111111-1111-4111-8111-111111111111',
  processingRunId: '22222222-2222-4222-8222-222222222222',
  fromChunkId: 'chunk:source',
  relationType: 'SOURCE_BLOCK' as const,
  toChunkId: null,
  toBlockId: 'block-1',
  ordinal: 0,
  metadata: {},
  createdAt: '2026-08-18T00:00:00.000Z',
};

describe('[KNO-001] M04 knowledge processing contracts', () => {
  it('关系必须且只能指向一个 Chunk 或 Block', () => {
    expect(ChunkRelationSchema.safeParse(validRelation).success).toBe(true);
    expect(
      ChunkRelationSchema.safeParse({
        ...validRelation,
        toChunkId: 'chunk:target',
      }).success,
    ).toBe(false);
    expect(
      ChunkRelationSchema.safeParse({
        ...validRelation,
        toBlockId: null,
      }).success,
    ).toBe(false);
  });

  it('[KNO-011][KNO-012] 审核拒绝空理由和失效的乐观锁版本', () => {
    expect(
      ReviewQualityRequestSchema.safeParse({
        action: 'APPROVE',
        expectedVersion: 3,
        reason: '人工抽检来源完整',
      }).success,
    ).toBe(true);
    expect(
      ReviewQualityRequestSchema.safeParse({
        action: 'REJECT',
        expectedVersion: 0,
        reason: ' ',
      }).success,
    ).toBe(false);
  });
});
