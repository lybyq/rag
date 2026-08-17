/**
 * M04 人工审核状态规则。
 * 规则保持为纯函数，HTTP 和 PostgreSQL 事务都必须执行同一约束，防止绕过 Controller 直接覆盖审核状态。
 *
 * @requirement KNO-012
 * @requirement KNO-013
 */
import type { QualityReviewAction, QualityReviewDecision, QualityVerdict } from '@rag/contracts';

/** 非法审核动作使用稳定领域错误，由 API 映射为 HTTP 409。 */
export class IllegalQualityReviewError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IllegalQualityReviewError';
  }
}

/**
 * 校验审核动作并返回新的审核状态。
 * REJECT 是自动硬门禁，审核者不能以 APPROVE 绕过；只能确认拒绝或要求新 revision 重处理。
 */
export function decideQualityReview(
  verdict: QualityVerdict,
  current: QualityReviewDecision,
  action: QualityReviewAction,
): QualityReviewDecision {
  if (!['PENDING', 'NOT_REQUIRED'].includes(current)) {
    throw new IllegalQualityReviewError('当前质量报告已经完成审核，禁止重复覆盖');
  }
  if (verdict === 'PASS') {
    throw new IllegalQualityReviewError('自动通过的质量报告不需要人工审核');
  }
  if (verdict === 'REJECT' && action === 'APPROVE') {
    throw new IllegalQualityReviewError('硬拒绝结论不能由人工批准绕过');
  }
  if (action === 'APPROVE') return 'APPROVED';
  if (action === 'REJECT') return 'REJECTED';
  return 'REPROCESS_REQUESTED';
}
