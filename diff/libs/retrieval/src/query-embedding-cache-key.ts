/**
 * Query Embedding 缓存键生成器。
 *
 * 缓存值只是“某段文本经过某个确定模型配置后得到的向量”，并不是带权限的检索结果。
 * 因此 Key 只包含会改变向量数值的事实，不能混入 Run 时间、检索 Filter、用户或空间；
 * 权限、发布版本和生效期仍由每次检索后的 PostgreSQL 回源复核负责。
 *
 * @requirement RET-008
 * @requirement OPT-016
 */
import { createHash } from 'node:crypto';

/** 会影响查询向量数值的完整输入事实。 */
export interface QueryEmbeddingCacheKeyInput {
  /** 实际送给 Embedding Provider 的查询文本；只会以 SHA-256 形式进入缓存键。 */
  readonly text: string;
  /** 模型身份。 */
  readonly modelId: string;
  /** 模型或权重修订。 */
  readonly revision: string;
  /** Dense 向量维度。 */
  readonly denseDimension: number;
  /** 查询侧输入模板版本。 */
  readonly queryTemplateVersion: string;
  /** Provider 是否归一化 Dense 向量。 */
  readonly normalizeDense: boolean;
  /** 实际请求的 Dense/Sparse 输出模式。 */
  readonly outputModes: readonly string[];
  /** Sparse 编码格式；Dense-only 时为 null。 */
  readonly sparseFormatVersion: string | null;
}

/**
 * 生成不会泄漏原问题、且可跨 Run 复用的稳定缓存键。
 *
 * 输出模式排序后再 Hash，避免仅配置书写顺序不同造成无意义失效。
 */
export function buildQueryEmbeddingCacheKey(input: QueryEmbeddingCacheKeyInput): string {
  const identity = {
    denseDimension: input.denseDimension,
    modelId: input.modelId,
    normalizeDense: input.normalizeDense,
    outputModes: [...input.outputModes].sort(),
    queryTemplateVersion: input.queryTemplateVersion,
    revision: input.revision,
    sparseFormatVersion: input.sparseFormatVersion,
    textSha256: createHash('sha256').update(input.text).digest('hex'),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
