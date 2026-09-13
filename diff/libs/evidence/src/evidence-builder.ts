/**
 * 证据包构建纯函数。
 *
 * 本层把 PostgreSQL 已复核的 Chunk 材料、检索分数和专用 Reranker 分数组合为 EvidenceBundle，
 * 计算子问题覆盖、来源权威度、冲突和总置信度。它不访问数据库、不调用模型，也不允许模型
 * 改写权限、Manifest 或生效时间事实。
 *
 * @requirement ANS-003
 * @requirement ANS-004
 * @requirement ANS-010
 */
import type { ExpandedEvidenceMaterial } from '@rag/application';
import {
  EvidenceBundleSchema,
  type EvidenceAuthority,
  type EvidenceBundle,
  type EvidenceConflict,
  type EvidenceSource,
  type RerankScore,
  type RetrievalCandidate,
} from '@rag/contracts';
import { createHash, randomUUID } from 'node:crypto';

/** 构建证据包的全部确定性输入。 */
export interface BuildEvidenceBundleInput {
  readonly runId: string;
  readonly subQuestions: readonly string[];
  readonly candidates: readonly RetrievalCandidate[];
  readonly materials: readonly ExpandedEvidenceMaterial[];
  readonly rerankScores: readonly RerankScore[];
  readonly degraded: boolean;
  readonly createSourceId?: () => string;
}

/** 把已复核来源转成带不透明 sourceId 的证据包。 */
export function buildEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
  const scoreByCandidate = new Map(
    input.rerankScores.map((score) => [score.candidateId, platformRerankerScore(score.score)]),
  );
  const retrievalByCandidate = new Map(
    input.candidates.map((candidate) => [
      candidate.chunkId,
      normalizeRetrievalScore(candidate.rrfScore),
    ]),
  );
  const createSourceId = input.createSourceId ?? randomUUID;
  const seenChunks = new Set<string>();
  const sources: EvidenceSource[] = [];

  for (const material of input.materials) {
    // 同一 Chunk 可能同时被父子、相邻关系命中。只保留第一次且分数最高的确定顺序，避免上下文重复。
    // 表头与表格正文共享授权 Chunk，但承载不同证据文本，因此按关系保留一份表头证据。
    const evidenceKey =
      material.relation === 'TABLE_HEADER' ? `${material.chunkId}:TABLE_HEADER` : material.chunkId;
    if (seenChunks.has(evidenceKey)) continue;
    seenChunks.add(evidenceKey);
    const rerankerScore = scoreByCandidate.get(material.originCandidateId) ?? 0;
    const retrievalScore = retrievalByCandidate.get(material.originCandidateId) ?? 0;
    const coverageMatches = matchingSubQuestions(
      `${material.title} ${material.headingPath.join(' ')} ${material.content}`,
      input.subQuestions,
      rerankerScore,
      retrievalScore,
    );
    const subQuestionIndexes = coverageMatches.map((match) => match.subQuestionIndex);
    const relationPenalty = material.relation === 'SELF' ? 1 : 0.88;
    sources.push({
      sourceId: createSourceId(),
      relation: material.relation,
      originCandidateId: material.originCandidateId,
      manifestId: material.manifestId,
      spaceId: material.spaceId,
      documentId: material.documentId,
      documentVersionId: material.documentVersionId,
      contentRevision: material.contentRevision,
      chunkId: material.chunkId,
      title: material.title,
      headingPath: [...material.headingPath],
      content: material.content,
      sourceLocations: [...material.sourceLocations],
      authority: inferAuthority(material.title, material.headingPath),
      publishedAt: material.publishedAt,
      effectiveFrom: material.effectiveFrom,
      effectiveTo: material.effectiveTo,
      retrievalScore: retrievalScore * relationPenalty,
      rerankerScore: rerankerScore * relationPenalty,
      subQuestionIndexes,
      coverageBasis: [...coverageMatches],
    });
  }

  sources.sort(
    (left, right) =>
      right.rerankerScore - left.rerankerScore ||
      right.retrievalScore - left.retrievalScore ||
      left.chunkId.localeCompare(right.chunkId),
  );
  const coverage = input.subQuestions.map((subQuestion, subQuestionIndex) => {
    const matching = sources.filter((source) =>
      source.subQuestionIndexes.includes(subQuestionIndex),
    );
    const best = Math.max(
      0,
      ...matching.map(
        (source) =>
          source.rerankerScore * 0.65 +
          source.retrievalScore * 0.2 +
          authorityWeight(source.authority) * 0.15,
      ),
    );
    return {
      subQuestionIndex,
      subQuestion,
      status:
        matching.length === 0
          ? ('MISSING' as const)
          : best >= 0.55
            ? ('COVERED' as const)
            : ('PARTIAL' as const),
      sourceIds: matching.map((source) => source.sourceId),
      confidence: clamp(best),
    };
  });
  const conflicts = detectConflicts(sources);
  const missingConditions = coverage.flatMap((item) =>
    item.status === 'MISSING'
      ? [
          {
            code: 'SUBQUESTION_EVIDENCE_MISSING',
            description: `子问题 ${item.subQuestionIndex + 1} 缺少可用证据`,
            subQuestionIndexes: [item.subQuestionIndex],
          },
        ]
      : [],
  );
  const coverageConfidence =
    coverage.length === 0
      ? 0
      : coverage.reduce((sum, item) => sum + item.confidence, 0) / coverage.length;
  const conflictPenalty = conflicts.length > 0 ? 0.35 : 1;
  const degradationPenalty = input.degraded ? 0.85 : 1;
  const confidence = clamp(coverageConfidence * conflictPenalty * degradationPenalty);
  const bundleFingerprint = JSON.stringify({
    runId: input.runId,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      chunkId: source.chunkId,
      contentSha256: createHash('sha256').update(source.content).digest('hex'),
      rerankerScore: source.rerankerScore,
    })),
    coverage,
    conflicts,
  });

  return EvidenceBundleSchema.parse({
    runId: input.runId,
    bundleSha256: createHash('sha256').update(bundleFingerprint).digest('hex'),
    sources,
    coverage,
    conflicts,
    missingConditions,
    confidence,
    degraded: input.degraded,
  });
}

/** 根据受控标题词推断权威度；无法确认时保持 UNKNOWN，绝不默认升级。 */
export function inferAuthority(title: string, headingPath: readonly string[]): EvidenceAuthority {
  const value = `${title} ${headingPath.join(' ')}`;
  if (/(制度|政策|办法|规定|policy|regulation)/iu.test(value)) return 'POLICY';
  if (/(流程|规程|操作|procedure|process)/iu.test(value)) return 'PROCEDURE';
  if (/(指南|指引|手册|guide|guidance)/iu.test(value)) return 'GUIDANCE';
  if (/(参考|说明|reference|faq)/iu.test(value)) return 'REFERENCE';
  return 'UNKNOWN';
}

function matchingSubQuestions(
  content: string,
  questions: readonly string[],
  rerankerScore: number,
  retrievalScore: number,
): readonly NonNullable<EvidenceSource['coverageBasis']>[number][] {
  const contentTokens = tokenSet(content);
  return questions.flatMap((question, index) => {
    const questionTokens = tokenSet(question);
    const overlap = [...questionTokens].filter((token) => contentTokens.has(token)).length;
    const lexicalOverlapRatio = overlap / Math.max(1, questionTokens.size);
    // 专用 Reranker 已在 Adapter 统一成 0..1；词面或模型至少一项过门槛才承认覆盖。
    const acceptedBy =
      lexicalOverlapRatio >= 0.4
        ? ('LEXICAL' as const)
        : rerankerScore >= 0.62 && retrievalScore >= 0.35
          ? ('RERANKER' as const)
          : undefined;
    return acceptedBy
      ? [{ subQuestionIndex: index, lexicalOverlapRatio: clamp(lexicalOverlapRatio), acceptedBy }]
      : [];
  });
}

function tokenSet(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9._-]{1,}/gu) ?? [];
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const hanNgrams = hanRuns.flatMap((run) => {
    if (run.length <= 2) return [run];
    return Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2));
  });
  return new Set([...words, ...hanNgrams]);
}

function detectConflicts(sources: readonly EvidenceSource[]): EvidenceConflict[] {
  const definitions = [
    { kind: 'AMOUNT' as const, expression: /(?:¥|￥|人民币)?\s*\d+(?:\.\d+)?\s*(?:元|万元|万)?/gu },
    { kind: 'DATE' as const, expression: /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/gu },
    { kind: 'VERSION' as const, expression: /(?:v|版本)\s*\d+(?:\.\d+)*/giu },
    { kind: 'CODE' as const, expression: /\b[A-Z]{2,10}[-_]\d{2,20}\b/gu },
  ];
  const conflicts: EvidenceConflict[] = [];
  for (const definition of definitions) {
    const scoped = new Map<
      string,
      { value: string; sourceId: string; documentVersionId: string }[]
    >();
    for (const source of sources) {
      const matches = [...source.content.matchAll(definition.expression)];
      const unique = [...new Set(matches.map((match) => match[0]))];
      // 一段材料本身包含多个值时无法确定它们是否描述同一字段，交给 Claim Validator 而不是误报冲突。
      if (unique.length !== 1) continue;
      // ANS-004：金额/日期只有落在同一子问题和同一末级章节时才可比较。企业制度通常在审批、
      // 住宿、报销时限等不同章节合法出现不同数字；跨章节直接比字面值会把正常制度误判为冲突。
      const heading = source.headingPath.at(-1)?.trim().toLowerCase() ?? '';
      // 空标题或未覆盖任何子问题时没有足够“同一字段”事实，宁可不报冲突也不误拒答。
      if (!heading || source.subQuestionIndexes.length === 0) continue;
      const match = matches[0];
      if (!match || match.index === undefined) continue;
      const scope = `${[...source.subQuestionIndexes].sort((left, right) => left - right).join(',')}:${heading}:${comparisonScopeKey(
        source.content,
        match.index,
        match[0].length,
      )}`;
      const values = scoped.get(scope) ?? [];
      values.push({
        value: normalizeLiteral(unique[0] ?? ''),
        sourceId: source.sourceId,
        documentVersionId: source.documentVersionId,
      });
      scoped.set(scope, values);
    }
    for (const values of scoped.values()) {
      const distinct = [...new Set(values.map((value) => value.value))];
      const documentVersions = new Set(values.map((value) => value.documentVersionId));
      // 同一文档版本中的父子/相邻 Chunk 是一个权威来源的上下文展开，不能互相制造冲突。
      if (distinct.length < 2 || documentVersions.size < 2) continue;
      conflicts.push({
        kind: definition.kind,
        normalizedValues: distinct,
        sourceIds: [...new Set(values.map((value) => value.sourceId))],
        description: `不同来源包含不一致的${conflictLabel(definition.kind)}`,
      });
    }
  }
  return conflicts;
}

function conflictLabel(kind: EvidenceConflict['kind']): string {
  return { AMOUNT: '金额', DATE: '日期', VERSION: '版本', CODE: '编号' }[kind];
}

function normalizeLiteral(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[年月/.]/gu, '-')
    .replace(/日$/u, '');
}

function platformRerankerScore(score: number): number {
  if (score < 0 || score > 1) {
    throw new Error('RERANKER_SCORE_NOT_NORMALIZED');
  }
  return score;
}

/** 用数值附近的主体/字段文字形成保守可比范围；去掉数值后范围不同则不判确定冲突。 */
function comparisonScopeKey(content: string, start: number, length: number): string {
  return `${content.slice(Math.max(0, start - 18), start)} ${content.slice(start + length, start + length + 18)}`
    .toLowerCase()
    .replace(/[\d\s.,，。:：;；()（）￥¥万年月日/_-]+/gu, '')
    .slice(0, 40);
}

function normalizeRetrievalScore(score: number): number {
  return clamp(score <= 0 ? 0 : score / (score + 0.02));
}

function authorityWeight(authority: EvidenceAuthority): number {
  return { POLICY: 1, PROCEDURE: 0.9, GUIDANCE: 0.75, REFERENCE: 0.6, UNKNOWN: 0.4 }[authority];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
