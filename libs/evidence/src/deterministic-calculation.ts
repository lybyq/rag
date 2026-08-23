/**
 * 金额、日期和简单算术的确定性计算器。
 *
 * 这里只接受白名单表达式并使用显式运算，不调用 `eval`。计算结果连同表达式和来源写入上下文，
 * LLM 只能复述，不能自行猜测金额或日期差。
 *
 * @requirement ANS-008
 * @requirement ANS-011
 */
import {
  DeterministicCalculationSchema,
  type DeterministicCalculation,
  type EvidenceBundle,
} from '@rag/contracts';
import { randomUUID } from 'node:crypto';

/** 从问题中执行有限算术或日期间隔计算。 */
export function calculateDeterministicFacts(
  question: string,
  bundle: EvidenceBundle,
  createId: () => string = randomUUID,
): readonly DeterministicCalculation[] {
  const calculations: DeterministicCalculation[] = [];
  const arithmetic = question.match(/(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)/u);
  if (arithmetic) {
    const left = Number(arithmetic[1]);
    const right = Number(arithmetic[3]);
    const operator = arithmetic[2];
    const result = calculate(left, operator, right);
    const sourceIds = sourcesContaining(bundle, [arithmetic[1] ?? '', arithmetic[3] ?? '']);
    if (Number.isFinite(result) && sourceIds.length > 0) {
      calculations.push(
        DeterministicCalculationSchema.parse({
          calculationId: createId(),
          expression: `${left} ${operator} ${right}`,
          result: String(result),
          sourceIds,
        }),
      );
    }
  }
  const dates = [...question.matchAll(/\d{4}-\d{2}-\d{2}/gu)].map((match) => match[0]);
  if (dates.length >= 2) {
    const start = Date.parse(`${dates[0]}T00:00:00Z`);
    const end = Date.parse(`${dates[1]}T00:00:00Z`);
    const sourceIds = sourcesContaining(bundle, [dates[0] ?? '', dates[1] ?? '']);
    if (Number.isFinite(start) && Number.isFinite(end) && sourceIds.length > 0) {
      calculations.push(
        DeterministicCalculationSchema.parse({
          calculationId: createId(),
          expression: `${dates[1]} - ${dates[0]}`,
          result: `${Math.round((end - start) / 86_400_000)} 天`,
          sourceIds,
        }),
      );
    }
  }
  return calculations;
}

function calculate(left: number, operator: string | undefined, right: number): number {
  if (operator === '+') return left + right;
  if (operator === '-') return left - right;
  if (operator === '*') return left * right;
  if (operator === '/' && right !== 0) return left / right;
  return Number.NaN;
}

function sourcesContaining(bundle: EvidenceBundle, literals: readonly string[]): string[] {
  return bundle.sources
    .filter((source) => literals.every((literal) => source.content.includes(literal)))
    .map((source) => source.sourceId);
}
