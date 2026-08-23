/**
 * 查询规划与混合检索 文档/章节去重与多样性控制。
 *
 * 融合结果常被同一文档相邻 Chunk 占满；本算法保留 RRF 顺序，同时限制每文档、每章节配额，
 * 为后续 Reranker 提供覆盖更多来源的候选。它不改变权限结论，也不重新计算相关性分数。
 *
 * @requirement RET-011
 */
import type { RetrievalCandidate } from '@rag/contracts';

/** 多样性约束。 */
export interface DiversityLimits {
  readonly limit: number;
  readonly maxPerDocument: number;
  readonly maxPerSection: number;
}

/** 按既有相关性顺序选择候选，并对 documentId 与稳定 headingPath 同时计数。 */
export function diversifyCandidates(
  candidates: readonly RetrievalCandidate[],
  limits: DiversityLimits,
): readonly RetrievalCandidate[] {
  assertPositive(limits.limit, 'limit');
  assertPositive(limits.maxPerDocument, 'maxPerDocument');
  assertPositive(limits.maxPerSection, 'maxPerSection');
  const documents = new Map<string, number>();
  const sections = new Map<string, number>();
  const selected: RetrievalCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limits.limit) break;
    const documentCount = documents.get(candidate.documentId) ?? 0;
    const sectionKey = `${candidate.documentId}:${candidate.headingPath.join('\u001f')}`;
    const sectionCount = sections.get(sectionKey) ?? 0;
    if (documentCount >= limits.maxPerDocument || sectionCount >= limits.maxPerSection) continue;
    selected.push(candidate);
    documents.set(candidate.documentId, documentCount + 1);
    sections.set(sectionKey, sectionCount + 1);
  }
  return selected;
}

function assertPositive(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
}
