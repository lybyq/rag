/**
 * Evidence Route 确定性状态机。
 *
 * 路由只读取检索状态、覆盖率、冲突和置信度；LLM 不能选择 ANSWER、绕过冲突或把无证据问题
 * 标记为可回答。低置信但有证据时才允许条件式 LLM Evidence Rerank。
 *
 * @requirement ANS-005
 * @requirement ANS-006
 */
import type { EvidenceBundle, EvidenceRoute, RetrievalRoute } from '@rag/contracts';

/** Evidence Router 输入。 */
export interface RouteEvidenceInput {
  readonly retrievalRoute: RetrievalRoute;
  readonly bundle: EvidenceBundle;
  readonly retrievalRoundCount: number;
  readonly maximumRetrievalRounds: number;
  readonly llmRerankAlreadyUsed?: boolean;
  readonly minimumConfidence?: number;
}

/** 返回七种受控路线之一。 */
export function routeEvidence(input: RouteEvidenceInput): EvidenceRoute {
  if (input.retrievalRoute === 'REJECT') return 'REJECT';
  if (input.retrievalRoute === 'CLARIFY' || input.retrievalRoute === 'CHAT') return 'CLARIFY';
  if (input.bundle.conflicts.length > 0) return 'CONFLICT';
  if (
    input.bundle.sources.length === 0 ||
    input.bundle.coverage.every((item) => item.status === 'MISSING')
  ) {
    return input.retrievalRoundCount < input.maximumRetrievalRounds
      ? 'REWRITE_AND_RETRY'
      : 'REJECT';
  }
  if (input.bundle.coverage.some((item) => item.status === 'MISSING')) return 'PARTIAL_ANSWER';
  if (input.bundle.coverage.some((item) => item.status === 'PARTIAL')) {
    return input.llmRerankAlreadyUsed ? 'PARTIAL_ANSWER' : 'LLM_RERANK';
  }
  if (input.bundle.confidence < (input.minimumConfidence ?? 0.58) && !input.llmRerankAlreadyUsed) {
    return 'LLM_RERANK';
  }
  return 'ANSWER';
}
