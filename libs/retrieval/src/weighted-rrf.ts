/**
 * 查询规划与混合检索 加权 Reciprocal Rank Fusion（RRF）纯算法。
 *
 * Dense 与 Sparse 分数量纲不可直接相加，RRF 只使用各路线排名并允许路线权重；本实现明确处理
 * 重复主键、缺失路线、并列分数和相等融合分，保证相同输入始终得到相同顺序。
 *
 * @requirement RET-010
 */
import type { FusedRetrievalCandidate, RetrievalVectorHit } from '@rag/contracts';

/** 一条有权重的有序召回列表。 */
export interface WeightedRetrievalList {
  readonly route: 'DENSE' | 'SPARSE';
  readonly weight: number;
  readonly hits: readonly RetrievalVectorHit[];
}

/** 使用 `weight / (k + rank)` 融合多条列表，并按 vectorId 打破最终平分。 */
export function weightedReciprocalRankFusion(
  lists: readonly WeightedRetrievalList[],
  k: number,
  limit: number,
): readonly FusedRetrievalCandidate[] {
  if (!Number.isInteger(k) || k <= 0) throw new Error('RRF k 必须是正整数');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('RRF limit 必须是正整数');
  const accumulated = new Map<string, FusedRetrievalCandidate>();
  for (const list of lists) {
    if (!Number.isFinite(list.weight) || list.weight < 0) throw new Error('RRF 权重非法');
    const deduplicated = deduplicateList(list.hits);
    for (let offset = 0; offset < deduplicated.length; offset += 1) {
      const hit = deduplicated[offset];
      if (!hit) continue;
      const rank = offset + 1;
      const existing = accumulated.get(hit.vectorId) ?? {
        vectorId: hit.vectorId,
        manifestId: hit.manifestId,
        spaceId: hit.spaceId,
        documentId: hit.documentId,
        denseRank: null,
        sparseRank: null,
        denseScore: null,
        sparseScore: null,
        rrfScore: 0,
      };
      accumulated.set(hit.vectorId, {
        ...existing,
        ...(list.route === 'DENSE'
          ? { denseRank: existing.denseRank ?? rank, denseScore: existing.denseScore ?? hit.score }
          : {
              sparseRank: existing.sparseRank ?? rank,
              sparseScore: existing.sparseScore ?? hit.score,
            }),
        rrfScore: existing.rrfScore + list.weight / (k + rank),
      });
    }
  }
  return [...accumulated.values()]
    .sort(
      (left, right) =>
        right.rrfScore - left.rrfScore || left.vectorId.localeCompare(right.vectorId),
    )
    .slice(0, limit);
}

function deduplicateList(hits: readonly RetrievalVectorHit[]): readonly RetrievalVectorHit[] {
  const best = new Map<string, RetrievalVectorHit>();
  for (const hit of hits) {
    const existing = best.get(hit.vectorId);
    if (
      !existing ||
      hit.rank < existing.rank ||
      (hit.rank === existing.rank && hit.score > existing.score)
    ) {
      best.set(hit.vectorId, hit);
    }
  }
  return [...best.values()].sort(
    (left, right) =>
      left.rank - right.rank ||
      right.score - left.score ||
      left.vectorId.localeCompare(right.vectorId),
  );
}
