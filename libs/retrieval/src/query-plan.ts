/**
 * M07 查询计划构造与实体优先级算法。
 *
 * LLM 返回值必须先通过 Application Port 的 Zod Schema，再交给本文件；本文件重新附加精确字面量、
 * 限制最多四个子问题，并用当前问题同类实体覆盖历史实体。它不接受或生成任何数据库表达式。
 *
 * @requirement RET-001
 * @requirement RET-003
 * @requirement RET-004
 * @requirement RET-005
 */
import { createHash } from 'node:crypto';
import {
  RetrievalPlanSchema,
  type ExactLiteral,
  type RetrievalEntity,
  type RetrievalFilter,
  type RetrievalPlan,
  type RetrievalProfileSnapshot,
  type RetrievalRoute,
  type QueryRewriteSuggestion,
} from '@rag/contracts';
import { restoreExactLiterals } from './exact-literals';

/** 经 Zod 校验的模型改写建议；刻意不包含 Filter/SQL/表达式字段。 */
export type ValidatedRewriteSuggestion = QueryRewriteSuggestion;

/** 查询计划构造输入。 */
export interface BuildRetrievalPlanInput {
  readonly question: string;
  readonly route: RetrievalRoute;
  readonly literals: readonly ExactLiteral[];
  readonly historyEntities: readonly RetrievalEntity[];
  readonly filter: RetrievalFilter;
  readonly profile: RetrievalProfileSnapshot;
  readonly round: 1 | 2;
  readonly suggestion?: ValidatedRewriteSuggestion;
}

/** 构造冻结查询计划；模型遗漏的原始条件会被确定性恢复。 */
export function buildRetrievalPlan(input: BuildRetrievalPlanInput): RetrievalPlan {
  const currentEntities: RetrievalEntity[] = [
    ...input.literals.map((literal) => ({
      kind: literal.kind,
      value: literal.value,
      source: 'CURRENT' as const,
    })),
    ...(input.suggestion?.entities ?? []).map((entity) => ({
      ...entity,
      source: 'CURRENT' as const,
    })),
  ];
  const entities = mergeEntities(currentEntities, input.historyEntities);
  const primaryQuery = restoreExactLiterals(
    input.suggestion?.rewrittenQuery ?? input.question,
    input.literals,
  );
  const suggested = input.suggestion?.subQuestions ?? [];
  const subQuestions = unique([
    primaryQuery,
    ...suggested.map((item) => restoreExactLiterals(item, input.literals)),
  ]).slice(0, 4);
  const body = {
    route: input.route,
    source: input.suggestion ? ('LLM_ASSISTED' as const) : ('DETERMINISTIC' as const),
    primaryQuery,
    subQuestions: subQuestions.length > 0 ? subQuestions : [primaryQuery],
    exactLiterals: input.literals,
    entities,
    filter: input.filter,
    round: input.round,
    profile: input.profile,
  };
  return RetrievalPlanSchema.parse({
    ...body,
    planSha256: createHash('sha256').update(stableStringify(body)).digest('hex'),
  });
}

/** 当前问题中出现某类实体时，历史同类实体全部失效；其余历史实体可用于指代补全。 */
export function mergeEntities(
  current: readonly RetrievalEntity[],
  history: readonly RetrievalEntity[],
): readonly RetrievalEntity[] {
  const currentKinds = new Set(current.map((entity) => entity.kind));
  return uniqueEntities([
    ...current,
    ...history
      .filter((entity) => !currentKinds.has(entity.kind))
      .map((entity) => ({ ...entity, source: 'HISTORY' as const })),
  ]);
}

/** 第二轮只做一次确定性放宽，不再次调用 LLM，避免无界改写循环。 */
export function buildSecondRoundQuestion(plan: RetrievalPlan): string {
  const literalSuffix = plan.exactLiterals.map((literal) => literal.value).join(' ');
  const base = plan.primaryQuery
    .replace(/(?:请问|帮我|查询|查一下|介绍一下|详细说明)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return unique([base, literalSuffix].filter(Boolean)).join(' ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(values: readonly RetrievalEntity[]): RetrievalEntity[] {
  const seen = new Set<string>();
  return values.filter((entity) => {
    const key = `${entity.kind}:${entity.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
