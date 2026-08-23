/**
 * 证据与答案跨进程契约的反例测试。
 *
 * 这些测试优先固定“模型不能输出无引用 Claim、客户端不能伪造非 UUID 引用、最终状态只能来自
 * 服务端枚举”等边界，后续 Adapter 和 LangGraph 都必须复用相同 Schema。
 *
 * @requirement ANS-001
 * @requirement ANS-009
 * @requirement ANS-010
 * @requirement ANS-016
 * @requirement ANS-017
 */
import {
  AnswerDraftSchema,
  EvidenceBundleSchema,
  FinalAnswerStatusSchema,
  ValidationReportSchema,
} from './answer-generation';

const sourceId = '11111111-1111-4111-8111-111111111111';

describe('[ANS-001][ANS-009][ANS-010] answer generation contracts', () => {
  it('拒绝没有引用或使用可读数据库主键伪造引用的 Claim', () => {
    const base = {
      summary: '差旅标准以当前制度为准。',
      caveats: [],
      followUpQuestion: null,
    };
    expect(
      AnswerDraftSchema.safeParse({
        ...base,
        claims: [
          {
            claimId: 'claim-1',
            kind: 'FACT',
            text: '住宿标准为 500 元。',
            sourceIds: [],
            calculationId: null,
            supportMode: 'DIRECT',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AnswerDraftSchema.safeParse({
        ...base,
        claims: [
          {
            claimId: 'claim-1',
            kind: 'FACT',
            text: '住宿标准为 500 元。',
            sourceIds: ['chunk-42'],
            calculationId: null,
            supportMode: 'DIRECT',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('接受结构化且有不透明引用的 Draft', () => {
    expect(
      AnswerDraftSchema.parse({
        summary: '住宿标准为 500 元。',
        claims: [
          {
            claimId: 'claim-1',
            kind: 'FACT',
            text: '住宿标准为 500 元。',
            sourceIds: [sourceId],
            calculationId: null,
            supportMode: 'DIRECT',
          },
        ],
        caveats: [],
        followUpQuestion: null,
      }).claims,
    ).toHaveLength(1);
  });
});

describe('[ANS-004][ANS-011][ANS-016] evidence and final outcome contracts', () => {
  it('拒绝越界置信度和非哈希证据包', () => {
    expect(
      EvidenceBundleSchema.safeParse({
        runId: sourceId,
        bundleSha256: 'unsafe',
        sources: [],
        coverage: [],
        conflicts: [],
        missingConditions: [],
        confidence: 1.1,
        degraded: false,
      }).success,
    ).toBe(false);
  });

  it('只允许五种用户可见终态，校验报告必须记录 Validator Profile', () => {
    expect(FinalAnswerStatusSchema.options).toEqual([
      'ANSWERED',
      'PARTIAL',
      'CLARIFICATION',
      'CONFLICT',
      'REJECTED',
    ]);
    expect(
      ValidationReportSchema.safeParse({
        outcome: 'PASS',
        issues: [],
        checkedClaimCount: 0,
        validSourceIds: [],
        semanticJudge: null,
      }).success,
    ).toBe(false);
  });
});
