/** M04 审核状态机领域测试。 @requirement KNO-012 @requirement KNO-013 */
import { decideQualityReview, IllegalQualityReviewError } from './review-policy';

describe('[KNO-012][KNO-013] quality review policy', () => {
  it('人工复核结论可以批准、拒绝或要求重处理', () => {
    expect(decideQualityReview('MANUAL_REVIEW', 'PENDING', 'APPROVE')).toBe('APPROVED');
    expect(decideQualityReview('MANUAL_REVIEW', 'PENDING', 'REJECT')).toBe('REJECTED');
    expect(decideQualityReview('MANUAL_REVIEW', 'PENDING', 'REQUEST_REPROCESS')).toBe(
      'REPROCESS_REQUESTED',
    );
  });

  it('硬拒绝不能被人工批准绕过', () => {
    expect(() => decideQualityReview('REJECT', 'PENDING', 'APPROVE')).toThrow(
      IllegalQualityReviewError,
    );
  });

  it('终态审核不能再次覆盖', () => {
    expect(() => decideQualityReview('MANUAL_REVIEW', 'APPROVED', 'REJECT')).toThrow(
      '禁止重复覆盖',
    );
  });
});
