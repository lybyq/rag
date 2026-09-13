/**
 * 检索候选池与并发快照契约回归测试。
 *
 * @requirement RET-014
 */
import { RetrievalProfileSnapshotSchema } from './retrieval';

const valid = {
  profileId: 'hybrid-medium-v2',
  initialTopK: 40,
  candidatePoolTopK: 30,
  finalTopK: 12,
  maxConcurrency: 8,
  rrfK: 60,
  denseWeight: 1,
  sparseWeight: 0,
  maxPerDocument: 3,
  maxPerSection: 2,
  minimumResults: 3,
  maxRounds: 2,
};

describe('[RET-014] retrieval profile candidate pool', () => {
  it('接受最终 TopK 不大于候选池、候选池不大于初始召回的快照', () => {
    expect(RetrievalProfileSnapshotSchema.safeParse(valid).success).toBe(true);
  });

  it.each([{ candidatePoolTopK: 10 }, { candidatePoolTopK: 41 }, { maxConcurrency: 0 }])(
    '拒绝不安全参数 %#',
    (change) => {
      expect(RetrievalProfileSnapshotSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    },
  );

  it('兼容升级前已经持久化、尚无新增字段的 Run 快照', () => {
    const legacy = {
      profileId: valid.profileId,
      initialTopK: valid.initialTopK,
      finalTopK: valid.finalTopK,
      rrfK: valid.rrfK,
      denseWeight: valid.denseWeight,
      sparseWeight: valid.sparseWeight,
      maxPerDocument: valid.maxPerDocument,
      maxPerSection: valid.maxPerSection,
      minimumResults: valid.minimumResults,
      maxRounds: valid.maxRounds,
    };
    expect(RetrievalProfileSnapshotSchema.safeParse(legacy).success).toBe(true);
  });
});
