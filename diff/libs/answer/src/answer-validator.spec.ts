/**
 * 答案校验、一次修复决策和严格最终化的安全回归测试。
 *
 * @requirement ANS-010
 * @requirement ANS-011
 * @requirement ANS-012
 * @requirement ANS-014
 * @requirement ANS-015
 * @requirement ANS-016
 * @requirement ANS-019
 */
import type { AnswerDraft, EvidenceBundle, SemanticGroundingReport } from '@rag/contracts';
import { validateAnswer } from './answer-validator';
import { finalizeAnswer, renderFinalAnswer } from './final-answer';
import validationGolden from '../../../test/fixtures/answer-generation/golden-validation-outcomes.json';
import finalStatusGolden from '../../../test/fixtures/answer-generation/golden-final-statuses.json';

const ids = {
  source: '11111111-1111-4111-8111-111111111111',
  invalidSource: '22222222-2222-4222-8222-222222222222',
  run: '33333333-3333-4333-8333-333333333333',
  manifest: '44444444-4444-4444-8444-444444444444',
  space: '55555555-5555-4555-8555-555555555555',
  document: '66666666-6666-4666-8666-666666666666',
  version: '77777777-7777-4777-8777-777777777777',
};

describe('[ANS-010..014] deterministic answer validator', () => {
  it('无权引用属于确定性阻断，即使 Semantic Judge 声称支持也不能 PASS', () => {
    const draft = answerDraft('北京住宿标准为 500 元。', ids.source, 'SEMANTIC');
    const judge: SemanticGroundingReport = {
      modelId: 'judge',
      revision: '1',
      reason: '规则无法判断语义蕴含',
      supportedClaimIds: ['claim-1'],
      unsupportedClaimIds: [],
    };
    const report = validateAnswer({
      draft,
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [],
      validatorProfileId: 'validator-v1',
      semanticJudge: judge,
    });
    expect(report.outcome).toBe('REJECT');
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CITATION_REVALIDATION_FAILED' })]),
    );
  });

  it('金额不在引用中时要求修复，引用存在且金额一致时通过', () => {
    const unsupported = validateAnswer({
      draft: answerDraft('北京住宿标准为 800 元。', ids.source, 'DIRECT'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });
    expect(unsupported.outcome).toBe('REGENERATE');
    const supported = validateAnswer({
      draft: answerDraft('北京住宿标准为 500 元。', ids.source, 'DIRECT'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });
    expect(supported.outcome).toBe('PASS');
  });

  it('伪造的 sourceId 不会因格式合法而通过', () => {
    const report = validateAnswer({
      draft: answerDraft('北京住宿标准为 500 元。', ids.invalidSource, 'DIRECT'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.invalidSource],
      validatorProfileId: 'validator-v1',
    });
    expect(report.outcome).toBe('REJECT');
    expect(report.issues[0]?.code).toBe('CITATION_NOT_FOUND');
  });

  it('[OPT-003] DIRECT 标签不能让引用窗口中不存在的结论通过', () => {
    const report = validateAnswer({
      draft: answerDraft('北京住宿标准提高到 500 元。', ids.source, 'DIRECT'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });

    expect(report.outcome).toBe('REGENERATE');
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DIRECT_CLAIM_TEXT_UNSUPPORTED' })]),
    );
  });

  it('[OPT-005] Judge 关闭时 DIRECT 可通过，SEMANTIC 必须改写而不能冒充已核验', () => {
    const direct = validateAnswer({
      draft: answerDraft('北京住宿标准为 500 元。', ids.source, 'DIRECT'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
      semanticJudgeEnabled: false,
    });
    const semantic = validateAnswer({
      draft: answerDraft('北京住宿标准为 500 元。', ids.source, 'SEMANTIC'),
      bundle: evidenceBundle(),
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
      semanticJudgeEnabled: false,
    });

    expect(direct.outcome).toBe('PASS');
    expect(semantic.outcome).toBe('REGENERATE');
    expect(semantic.issues.map((item) => item.code)).toContain('SEMANTIC_JUDGE_DISABLED');
  });

  it.each(validationGolden)('$name -> $expected', ({ mode, expected }) => {
    const bundle = evidenceBundle();
    if (mode === 'MISSING_COVERAGE') {
      bundle.coverage = [
        {
          subQuestionIndex: 0,
          subQuestion: '缺少的条件',
          status: 'MISSING',
          sourceIds: [],
          confidence: 0,
        },
      ];
    }
    const report = validateAnswer({
      draft: answerDraft(
        mode === 'UNSUPPORTED_AMOUNT' ? '北京住宿标准为 800 元。' : '北京住宿标准为 500 元。',
        ids.source,
        'DIRECT',
      ),
      bundle,
      calculations: [],
      currentlyValidSourceIds: mode === 'REVOKED' ? [] : [ids.source],
      validatorProfileId: 'validator-v1',
    });
    expect(report.outcome).toBe(expected);
  });
});

describe('[ANS-015][ANS-016] strict final answer', () => {
  it('只有校验通过的 Claim 才进入渲染正文和引用', () => {
    const bundle = evidenceBundle();
    const draft = answerDraft('北京住宿标准为 500 元。', ids.source, 'DIRECT');
    const validation = validateAnswer({
      draft,
      bundle,
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });
    const finalAnswer = finalizeAnswer({ route: 'ANSWER', bundle, draft, validation });
    const rendered = renderFinalAnswer(finalAnswer);
    expect(finalAnswer.status).toBe('ANSWERED');
    expect(finalAnswer.summary).toBe('北京住宿标准为 500 元。');
    expect(rendered).toContain(`[${ids.source}]`);
  });

  it('[OPT-003] 最终摘要只由已校验 Claim 合成，不发布模型额外写入的结论', () => {
    const bundle = evidenceBundle();
    const draft = {
      ...answerDraft('北京住宿标准为 500 元。', ids.source, 'DIRECT'),
      summary: '北京住宿标准为 800 元。',
    };
    const validation = validateAnswer({
      draft,
      bundle,
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });

    const finalAnswer = finalizeAnswer({ route: 'ANSWER', bundle, draft, validation });
    expect(finalAnswer.summary).toBe('北京住宿标准为 500 元。');
    expect(finalAnswer.summary).not.toContain('800');
  });

  it('冲突路线不泄漏未经校验 Draft', () => {
    const bundle = evidenceBundle();
    const validation = validateAnswer({
      draft: answerDraft('模型偷偷选择 500 元。', ids.source, 'DIRECT'),
      bundle,
      calculations: [],
      currentlyValidSourceIds: [ids.source],
      validatorProfileId: 'validator-v1',
    });
    const answer = finalizeAnswer({ route: 'CONFLICT', bundle, validation });
    expect(answer.status).toBe('CONFLICT');
    expect(renderFinalAnswer(answer)).not.toContain('模型偷偷选择');
  });

  it.each(finalStatusGolden)('$name -> $expected', ({ route, validation, draft, expected }) => {
    const bundle = evidenceBundle();
    const answer = finalizeAnswer({
      route: route as Parameters<typeof finalizeAnswer>[0]['route'],
      bundle,
      validation: {
        outcome: validation as Parameters<typeof finalizeAnswer>[0]['validation']['outcome'],
        issues: [],
        checkedClaimCount: draft ? 1 : 0,
        validSourceIds: draft ? [ids.source] : [],
        validatorProfileId: 'validator-v1',
        semanticJudge: null,
      },
      ...(draft ? { draft: answerDraft('北京住宿标准为 500 元。', ids.source, 'DIRECT') } : {}),
    });
    expect(answer.status).toBe(expected);
  });
});

function answerDraft(
  text: string,
  sourceId: string,
  supportMode: 'DIRECT' | 'SEMANTIC',
): AnswerDraft {
  return {
    summary: text,
    claims: [
      {
        claimId: 'claim-1',
        kind: 'FACT',
        text,
        sourceIds: [sourceId],
        calculationId: null,
        supportMode,
      },
    ],
    caveats: [],
    followUpQuestion: null,
  };
}

function evidenceBundle(): EvidenceBundle {
  return {
    runId: ids.run,
    bundleSha256: 'a'.repeat(64),
    sources: [
      {
        sourceId: ids.source,
        relation: 'SELF',
        originCandidateId: 'chunk-1',
        manifestId: ids.manifest,
        spaceId: ids.space,
        documentId: ids.document,
        documentVersionId: ids.version,
        contentRevision: 1,
        chunkId: 'chunk-1',
        title: '差旅制度',
        headingPath: ['住宿'],
        content: '北京住宿标准为 500 元。',
        sourceLocations: [],
        authority: 'POLICY',
        publishedAt: '2026-01-01T00:00:00.000Z',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        retrievalScore: 0.9,
        rerankerScore: 0.9,
        subQuestionIndexes: [0],
      },
    ],
    coverage: [
      {
        subQuestionIndex: 0,
        subQuestion: '北京住宿标准是多少',
        status: 'COVERED',
        sourceIds: [ids.source],
        confidence: 0.9,
      },
    ],
    conflicts: [],
    missingConditions: [],
    confidence: 0.9,
    degraded: false,
  };
}
