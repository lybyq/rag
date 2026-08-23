/**
 * 查询规划与混合检索 精确字面量提取与改写保护算法。
 *
 * 金额、日期、版本、编码、姓名和地域经常是企业问答的判定条件；语义改写若静默改变这些值，
 * 即使召回文本“看起来相关”也会命中错误制度版本。本文件只做确定性文本扫描和保护，
 * 不调用模型、不决定权限，也不把提取结果转换成数据库表达式。
 *
 * @requirement RET-003
 * @requirement RET-004
 */
import type { ExactLiteral, ExactLiteralKind } from '@rag/contracts';

interface LiteralPattern {
  readonly kind: ExactLiteralKind;
  readonly expression: RegExp;
}

const patterns: readonly LiteralPattern[] = [
  {
    kind: 'AMOUNT',
    expression:
      /(?:[￥¥$]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元|人民币|美元|RMB|CNY|USD))/giu,
  },
  {
    kind: 'DATE',
    expression:
      /(?:20\d{2}[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月](?:0?[1-9]|[12]\d|3[01])日?)?|20\d{2}年|20\d{2}Q[1-4])/giu,
  },
  { kind: 'VERSION', expression: /(?:\bv\d+(?:\.\d+){0,4}\b|版本\s*\d+(?:\.\d+){0,4})/giu },
  {
    kind: 'CODE',
    expression:
      /\b(?=[A-Z0-9._/-]{3,40}\b)(?=[A-Z0-9._/-]*[A-Z])(?=[A-Z0-9._/-]*\d)[A-Z0-9]+(?:[._/-][A-Z0-9]+)+\b/gu,
  },
  {
    kind: 'REGION',
    expression:
      /(?:北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区|(?:位于|在|地区|区域|地点)[：:\s]*[\p{Script=Han}]{1,8}(?:特别行政区|自治区|自治州|省|市|地区|区|县)|[\p{Script=Han}]{2,8}(?:省|自治区|自治州))/gu,
  },
  {
    kind: 'NAME',
    expression:
      /(?:姓名|员工|负责人|申请人|审批人)[：:\s]*[\p{Script=Han}·]{2,4}(?=在|于|，|,|。|\s|$)/gu,
  },
];

/**
 * 从问题中提取无重叠精确字面量。
 * 同一片段若命中多个规则，优先采用规则表中更具体、先出现的类别，结果按原文位置稳定排序。
 */
export function extractExactLiterals(question: string): readonly ExactLiteral[] {
  const found: ExactLiteral[] = [];
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    for (const match of question.matchAll(pattern.expression)) {
      const value = match[0]?.trim();
      const start = match.index;
      if (!value || start === undefined) continue;
      const end = start + value.length;
      if (found.some((item) => start < item.end && end > item.start)) continue;
      found.push({
        kind: pattern.kind,
        value,
        normalizedValue: normalizeLiteral(pattern.kind, value),
        start,
        end,
      });
    }
  }
  return found.sort((left, right) => left.start - right.start || left.end - right.end);
}

/** 返回改写文本中缺失的精确字面量；比较使用保守规范化，不做金额换算或日期猜测。 */
export function missingExactLiterals(
  rewritten: string,
  literals: readonly ExactLiteral[],
): readonly ExactLiteral[] {
  const normalizedRewrite = normalizeForContainment(rewritten);
  return literals.filter(
    (literal) => !normalizedRewrite.includes(normalizeForContainment(literal.value)),
  );
}

/**
 * 将模型遗漏的原始字面量重新附加为显式精确条件。
 * 这里使用原文值而不是模型“修正值”，避免代码、版本或金额被近似替换。
 */
export function restoreExactLiterals(rewritten: string, literals: readonly ExactLiteral[]): string {
  const missing = missingExactLiterals(rewritten, literals);
  if (missing.length === 0) return rewritten.trim();
  return `${rewritten.trim()}；精确条件：${missing.map((item) => item.value).join('、')}`;
}

function normalizeLiteral(kind: ExactLiteralKind, value: string): string {
  const compact = value.replace(/\s+/g, '');
  if (kind === 'CODE' || kind === 'VERSION') return compact.toLocaleUpperCase('en-US');
  if (kind === 'AMOUNT') return compact.replace(/,/g, '');
  return compact;
}

function normalizeForContainment(value: string): string {
  return value.replace(/[\s,，]/g, '').toLocaleUpperCase('en-US');
}
