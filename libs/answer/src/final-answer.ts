/**
 * 最终答案状态映射与确定性渲染。
 *
 * 模型只产出 Draft；本文件根据 Evidence Route 和 ValidationReport 决定用户可见状态，并把
 * Claim 渲染成带不透明引用的正文。校验失败时绝不回退到未经校验的模型原文。
 *
 * @requirement ANS-012
 * @requirement ANS-015
 * @requirement ANS-016
 * @requirement ANS-017
 */
import {
  FinalAnswerSchema,
  type AnswerDraft,
  type EvidenceBundle,
  type EvidenceRoute,
  type FinalAnswer,
  type ValidationReport,
} from '@rag/contracts';

/** 最终化输入。 */
export interface FinalizeAnswerInput {
  readonly route: EvidenceRoute;
  readonly bundle: EvidenceBundle;
  readonly validation: ValidationReport;
  readonly draft?: AnswerDraft;
}

/** 把受控路由和校验结论映射为五种终态。 */
export function finalizeAnswer(input: FinalizeAnswerInput): FinalAnswer {
  const fallback = routeFallback(input.route);
  if (!input.draft || fallback) {
    return FinalAnswerSchema.parse({
      status: fallback?.status ?? 'REJECTED',
      summary: fallback?.summary ?? '当前证据不足，无法安全回答。',
      claims: [],
      caveats: input.bundle.missingConditions.map((condition) => condition.description),
      followUpQuestion: fallback?.followUpQuestion ?? null,
      citations: [],
      validation: input.validation,
    });
  }
  if (input.validation.outcome === 'REJECT') {
    return FinalAnswerSchema.parse({
      status: 'REJECTED',
      summary: '答案校验未通过，未向你展示未经证据支持的内容。',
      claims: [],
      caveats: input.validation.issues.map((item) => item.description),
      followUpQuestion: input.draft.followUpQuestion,
      citations: [],
      validation: input.validation,
    });
  }
  const status =
    input.route === 'PARTIAL_ANSWER' || input.validation.outcome === 'PARTIAL'
      ? 'PARTIAL'
      : 'ANSWERED';
  const validSources = new Set(input.validation.validSourceIds);
  const claims = input.draft.claims.filter((claim) =>
    claim.sourceIds.every((sourceId) => validSources.has(sourceId)),
  );
  return FinalAnswerSchema.parse({
    status,
    summary: input.draft.summary,
    claims,
    caveats: [
      ...input.draft.caveats,
      ...input.bundle.missingConditions.map((condition) => condition.description),
    ],
    followUpQuestion: input.draft.followUpQuestion,
    citations: [...new Set(claims.flatMap((claim) => claim.sourceIds))],
    validation: input.validation,
  });
}

/** 严格模式下仅在最终化之后调用，把结构化事实渲染为用户正文。 */
export function renderFinalAnswer(answer: FinalAnswer): string {
  const lines = [`状态：${statusLabel(answer.status)}`, '', answer.summary];
  if (answer.claims.length > 0) {
    lines.push('', '依据：');
    for (const claim of answer.claims) {
      lines.push(`- ${claim.text} ${claim.sourceIds.map((id) => `[${id}]`).join(' ')}`);
    }
  }
  if (answer.caveats.length > 0) {
    lines.push('', '限制与提示：', ...answer.caveats.map((item) => `- ${item}`));
  }
  if (answer.followUpQuestion) lines.push('', `需要补充：${answer.followUpQuestion}`);
  return lines.join('\n');
}

function routeFallback(
  route: EvidenceRoute,
): { status: FinalAnswer['status']; summary: string; followUpQuestion: string | null } | undefined {
  if (route === 'CLARIFY') {
    return {
      status: 'CLARIFICATION',
      summary: '当前问题需要补充范围或条件后才能检索企业知识。',
      followUpQuestion: '请补充适用人员、地区、时间或具体制度范围。',
    };
  }
  if (route === 'CONFLICT') {
    return {
      status: 'CONFLICT',
      summary: '检索到的有效来源存在冲突，系统不会替你选择其中一个结论。',
      followUpQuestion: '请指定应采用的制度版本，或联系知识管理员确认。',
    };
  }
  if (route === 'REJECT' || route === 'REWRITE_AND_RETRY') {
    return {
      status: 'REJECTED',
      summary: '当前没有足够且有效的证据支持回答。',
      followUpQuestion: null,
    };
  }
  return undefined;
}

function statusLabel(status: FinalAnswer['status']): string {
  return {
    ANSWERED: '已回答',
    PARTIAL: '部分回答',
    CLARIFICATION: '需要澄清',
    CONFLICT: '证据冲突',
    REJECTED: '已拒答',
  }[status];
}
