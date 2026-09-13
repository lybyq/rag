/**
 * 最终答案确定性校验器。
 *
 * 校验器先检查引用存在性、当前权限复核结果、证据版本、金额/日期/编号、覆盖与冲突。
 * Semantic Judge 只能补充 `supportMode=SEMANTIC` 的判断，不能删除或覆盖任何确定性问题。
 *
 * @requirement ANS-010
 * @requirement ANS-011
 * @requirement ANS-012
 * @requirement ANS-013
 */
import {
  ValidationReportSchema,
  type AnswerDraft,
  type DeterministicCalculation,
  type EvidenceBundle,
  type SemanticGroundingReport,
  type ValidationIssue,
  type ValidationReport,
} from '@rag/contracts';

/** Validator 的全部可信输入。 */
export interface ValidateAnswerInput {
  readonly draft: AnswerDraft;
  readonly bundle: EvidenceBundle;
  readonly calculations: readonly DeterministicCalculation[];
  readonly currentlyValidSourceIds: readonly string[];
  readonly validatorProfileId: string;
  readonly semanticJudge?: SemanticGroundingReport;
  /** false 时 SEMANTIC Claim 不会被假装放行，必须修复为可确定性核验的 DIRECT Claim。 */
  readonly semanticJudgeEnabled?: boolean;
}

/** 执行不可被模型覆盖的最终校验。 */
export function validateAnswer(input: ValidateAnswerInput): ValidationReport {
  const bundleSources = new Map(input.bundle.sources.map((source) => [source.sourceId, source]));
  const validSourceIds = new Set(input.currentlyValidSourceIds);
  const calculations = new Map(
    input.calculations.map((calculation) => [calculation.calculationId, calculation]),
  );
  const issues: ValidationIssue[] = [];

  if (input.draft.claims.length === 0) {
    issues.push(issue('CLAIMS_MISSING', 'REPAIRABLE', null, '回答没有结构化 Claim'));
  }
  for (const claim of input.draft.claims) {
    const unknown = claim.sourceIds.filter((sourceId) => !bundleSources.has(sourceId));
    if (unknown.length > 0) {
      issues.push(
        issue('CITATION_NOT_FOUND', 'BLOCKING', claim.claimId, 'Claim 引用了不存在的来源'),
      );
      continue;
    }
    const revoked = claim.sourceIds.filter((sourceId) => !validSourceIds.has(sourceId));
    if (revoked.length > 0) {
      issues.push(
        issue(
          'CITATION_REVALIDATION_FAILED',
          'BLOCKING',
          claim.claimId,
          '引用已无权、过期或版本失效',
        ),
      );
      continue;
    }
    if (claim.kind === 'CALCULATION') {
      const calculation = claim.calculationId ? calculations.get(claim.calculationId) : undefined;
      if (!calculation) {
        issues.push(
          issue(
            'CALCULATION_NOT_FOUND',
            'BLOCKING',
            claim.claimId,
            '计算 Claim 未引用确定性计算事实',
          ),
        );
      } else if (!claim.text.includes(calculation.result)) {
        issues.push(
          issue(
            'CALCULATION_RESULT_MISMATCH',
            'REPAIRABLE',
            claim.claimId,
            'Claim 中的计算结果与代码结果不一致',
          ),
        );
      }
    }
    const literals = extractCriticalLiterals(claim.text);
    if (literals.length > 0 && claim.kind !== 'CALCULATION') {
      const citedText = claim.sourceIds
        .map((sourceId) => bundleSources.get(sourceId)?.content ?? '')
        .join('\n');
      const unsupported = literals.filter((literal) => !containsNormalized(citedText, literal));
      if (unsupported.length > 0) {
        issues.push(
          issue(
            'DETERMINISTIC_LITERAL_UNSUPPORTED',
            'REPAIRABLE',
            claim.claimId,
            '金额、日期、版本或编号没有出现在引用来源中',
          ),
        );
      }
    }
    if (claim.supportMode === 'DIRECT') {
      const citedText = claim.sourceIds
        .map((sourceId) => bundleSources.get(sourceId)?.content ?? '')
        .join('\n');
      if (!isDirectlySupported(citedText, claim.text)) {
        issues.push(
          issue(
            'DIRECT_CLAIM_TEXT_UNSUPPORTED',
            'REPAIRABLE',
            claim.claimId,
            'DIRECT Claim 含有引用窗口中不存在的关键信息',
          ),
        );
      }
    }
  }
  if (input.bundle.conflicts.length > 0) {
    issues.push(
      issue('EVIDENCE_CONFLICT', 'BLOCKING', null, '证据包含未解决的金额、日期、版本或编号冲突'),
    );
  }
  if (input.bundle.coverage.some((coverage) => coverage.status === 'MISSING')) {
    issues.push(issue('SUBQUESTION_COVERAGE_MISSING', 'WARNING', null, '部分子问题缺少证据'));
  }

  const semanticClaimIds = input.draft.claims
    .filter((claim) => claim.supportMode === 'SEMANTIC')
    .map((claim) => claim.claimId);
  if (semanticClaimIds.length > 0) {
    if (input.semanticJudgeEnabled === false) {
      issues.push(
        issue(
          'SEMANTIC_JUDGE_DISABLED',
          'REPAIRABLE',
          null,
          '当前策略关闭语义 Judge，请改用可核验的原文事实',
        ),
      );
    } else if (!input.semanticJudge) {
      issues.push(
        issue('SEMANTIC_JUDGE_REQUIRED', 'REPAIRABLE', null, '语义 Claim 尚未执行 Grounding Judge'),
      );
    } else {
      for (const claimId of input.semanticJudge.unsupportedClaimIds) {
        if (semanticClaimIds.includes(claimId)) {
          issues.push(
            issue('SEMANTIC_CLAIM_UNSUPPORTED', 'BLOCKING', claimId, '语义 Judge 未找到充分支持'),
          );
        }
      }
    }
  }

  const blocking = issues.some((item) => item.severity === 'BLOCKING');
  const repairable = issues.some((item) => item.severity === 'REPAIRABLE');
  const missingCoverage = issues.some((item) => item.code === 'SUBQUESTION_COVERAGE_MISSING');
  const outcome = blocking
    ? 'REJECT'
    : repairable
      ? 'REGENERATE'
      : missingCoverage
        ? 'PARTIAL'
        : 'PASS';
  return ValidationReportSchema.parse({
    outcome,
    issues,
    checkedClaimCount: input.draft.claims.length,
    validSourceIds: [...validSourceIds].filter((sourceId) => bundleSources.has(sourceId)),
    validatorProfileId: input.validatorProfileId,
    semanticJudge: input.semanticJudge ?? null,
  });
}

/** DIRECT 并非模型自报标签：Claim 中每个有意义 Token 都必须在实际引用窗口出现。 */
function isDirectlySupported(source: string, claim: string): boolean {
  const sourceTokens = groundingTokens(source);
  const claimTokens = groundingTokens(claim);
  if (claimTokens.size === 0) return false;
  return [...claimTokens].every((token) => sourceTokens.has(token));
}

function groundingTokens(value: string): Set<string> {
  const stopCharacters = new Set(['的', '了', '是', '为', '和', '与', '及', '在', '应', '可']);
  const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]/gu) ?? [];
  return new Set(tokens.filter((token) => !stopCharacters.has(token)));
}

/** 返回需要 Semantic Judge 的 Claim；调用方只有在确定性校验无阻断时才会使用。 */
export function semanticClaimIds(draft: AnswerDraft): readonly string[] {
  return draft.claims
    .filter((claim) => claim.supportMode === 'SEMANTIC')
    .map((claim) => claim.claimId);
}

function extractCriticalLiterals(value: string): string[] {
  const expressions = [
    /(?:¥|￥|人民币)?\s*\d+(?:\.\d+)?\s*(?:元|万元)/gu,
    /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/gu,
    /(?:v|版本)\s*\d+(?:\.\d+)*/giu,
    /\b[A-Z]{2,10}[-_]\d{2,20}\b/gu,
  ];
  return [...new Set(expressions.flatMap((expression) => value.match(expression) ?? []))];
}

function containsNormalized(source: string, literal: string): boolean {
  return normalize(source).includes(normalize(literal));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[年月/.]/gu, '-')
    .replace(/日/gu, '');
}

function issue(
  code: string,
  severity: ValidationIssue['severity'],
  claimId: string | null,
  description: string,
): ValidationIssue {
  return { code, severity, claimId, description };
}
