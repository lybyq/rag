/** M05 Manifest 对账与发布状态机回归测试。 */
import { reconcileManifestRecords } from './manifest-reconciliation';
import { assertManifestTransition, IllegalManifestTransitionError } from './publication-state';

describe('[IDX-009][IDX-010][IDX-011] manifest publication rules', () => {
  it('同时检查数量、主键、内容 Hash、Profile 与固定关键查询', () => {
    const report = reconcileManifestRecords({
      manifestId: '11111111-1111-4111-8111-111111111111',
      embeddingProfileId: 'bge-m3-v1',
      expected: [
        { vectorId: 'v1', contentSha256: 'a'.repeat(64) },
        { vectorId: 'v2', contentSha256: 'b'.repeat(64) },
      ],
      actual: [
        { vectorId: 'v1', contentSha256: 'f'.repeat(64), embeddingProfileId: 'wrong' },
        { vectorId: 'v3', contentSha256: 'c'.repeat(64), embeddingProfileId: 'bge-m3-v1' },
      ],
      fixedQueryReturnedIds: ['v3'],
      fixedQueryExpectedIds: ['v1'],
    });

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'MISSING_PRIMARY_KEY',
        'UNEXPECTED_PRIMARY_KEY',
        'CONTENT_HASH_MISMATCH',
        'PROFILE_MISMATCH',
        'FIXED_QUERY_MISMATCH',
      ]),
    );
    expect(report.reportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('构建中 Manifest 不能直接变 ACTIVE，验证后才能发布', () => {
    expect(() => assertManifestTransition('BUILDING', 'ACTIVE')).toThrow(
      IllegalManifestTransitionError,
    );
    expect(() => assertManifestTransition('BUILDING', 'VERIFIED')).not.toThrow();
    expect(() => assertManifestTransition('VERIFIED', 'ACTIVE')).not.toThrow();
  });

  it('旧 ACTIVE 可以回退为 SUPERSEDED，但不能重新进入 BUILDING', () => {
    expect(() => assertManifestTransition('ACTIVE', 'SUPERSEDED')).not.toThrow();
    expect(() => assertManifestTransition('ACTIVE', 'BUILDING')).toThrow(
      IllegalManifestTransitionError,
    );
  });
});
