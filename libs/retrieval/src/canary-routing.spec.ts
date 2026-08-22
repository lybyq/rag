/** IDX-016 稳定灰度分桶测试。 */
import { selectCanaryManifest } from './canary-routing';

describe('[IDX-016] selectCanaryManifest', () => {
  const route = {
    stableManifestId: 'stable',
    candidateManifestId: 'candidate',
    canaryPercent: 20,
    routingSalt: '11111111-1111-4111-8111-111111111111',
  };

  it('同一 userId 跨请求结果稳定，且 100 个样本同时覆盖稳定与候选', () => {
    const first = selectCanaryManifest('employee-42', route);
    expect(selectCanaryManifest('employee-42', route)).toBe(first);
    const selected = new Set(
      Array.from({ length: 100 }, (_, index) => selectCanaryManifest(`employee-${index}`, route)),
    );
    expect(selected).toEqual(new Set(['stable', 'candidate']));
  });

  it('拒绝 100% 伪 CANARY，要求改走 FULL 原子发布', () => {
    expect(() => selectCanaryManifest('employee', { ...route, canaryPercent: 100 })).toThrow(
      '路由参数非法',
    );
  });
});
