/**
 * M04 Chunking 纯算法内部类型。
 * 类型只依赖公共契约，不包含 NestJS、数据库或供应商 SDK，便于 Golden 测试和算法替换。
 *
 * @requirement KNO-002
 * @requirement KNO-003
 * @requirement KNO-004
 */
import type {
  ChunkContentType,
  ChunkDedupStatus,
  ChunkGranularity,
  ChunkRelationType,
  ChunkSourceLocation,
  DocumentBlock,
  DocumentQualityMetrics,
  QualityVerdict,
  SupportedFileFormat,
} from '@rag/contracts';

/** 结构恢复后对 Block 的语义标注。 */
export type StructuredBlockKind =
  | 'TITLE'
  | 'PROSE'
  | 'LIST'
  | 'TABLE'
  | 'CODE'
  | 'FAQ'
  | 'CLAUSE'
  | 'FOOTNOTE'
  | 'DECORATION';

/** 标准 Block 加上标题路径、稳定边界和是否参与切块的决策。 */
export interface StructuredBlock {
  readonly block: DocumentBlock;
  readonly kind: StructuredBlockKind;
  readonly headingPath: readonly string[];
  readonly boundaryKey: string;
  readonly includeInChunk: boolean;
}

/** Tokenizer 必须给出固定 Profile/Revision，使历史 tokenCount 可解释。 */
export interface TextTokenizer {
  readonly profileId: string;
  readonly revision: string;
  count(text: string): number;
  split(text: string, maxTokens: number, overlapTokens: number): readonly string[];
}

/** M04 可热配置但必须进入运行快照的 Chunk 参数。 */
export interface ChunkingPolicy {
  readonly childMaxTokens: number;
  readonly parentMaxTokens: number;
  readonly overlapTokens: number;
  readonly dedupMode: 'RETAIN' | 'SUPPRESS';
}

/** Chunker 的可信输入。 */
export interface BuildKnowledgeChunksInput {
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly fileFormat: SupportedFileFormat;
  readonly blocks: readonly DocumentBlock[];
}

/** 尚未持久化的 Chunk；时间和 Run ID 由事务 Adapter 补齐。 */
export interface KnowledgeChunkDraft {
  readonly id: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly ordinal: number;
  readonly granularity: ChunkGranularity;
  readonly contentType: ChunkContentType;
  readonly displayContent: string;
  readonly embeddingText: string;
  readonly tokenCount: number;
  readonly tokenizerProfileId: string;
  readonly tokenizerRevision: string;
  readonly headingPath: readonly string[];
  readonly sourceLocations: readonly ChunkSourceLocation[];
  readonly parentChunkId: string | null;
  readonly contentSha256: string;
  readonly dedupStatus: ChunkDedupStatus;
  readonly duplicateOfChunkId: string | null;
  readonly eligibleForIndex: boolean;
  readonly splitReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 尚未持久化的 Chunk 关系。 */
export interface ChunkRelationDraft {
  readonly fromChunkId: string;
  readonly relationType: ChunkRelationType;
  readonly toChunkId: string | null;
  readonly toBlockId: string | null;
  readonly ordinal: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Chunker 的确定性输出。 */
export interface KnowledgeChunkBuildResult {
  readonly chunks: readonly KnowledgeChunkDraft[];
  readonly relations: readonly ChunkRelationDraft[];
}

/** 质量阈值属于版本化 Policy，不允许在历史报告上就地重算。 */
export interface QualityPolicyConfig {
  readonly minimumNonEmptyBlockRatio: number;
  readonly rejectNonEmptyBlockRatio: number;
  readonly minimumOcrConfidence: number;
  readonly maximumGarbledRatio: number;
  readonly rejectGarbledRatio: number;
  readonly maximumDuplicateRatio: number;
  readonly requireHeadingAfterBlocks: number;
}

/** 质量计算所需事实全部显式输入，避免算法偷偷查询数据库。 */
export interface QualityEvaluationInput {
  readonly blocks: readonly DocumentBlock[];
  readonly chunks: readonly KnowledgeChunkDraft[];
  readonly expectedPageCount: number;
  readonly hasResponsibleOwner: boolean;
  readonly versionConsistent: boolean;
}

/** 未持久化质量发现项。 */
export interface QualityFindingDraft {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly code: string;
  readonly message: string;
  readonly pageNos: readonly number[];
  readonly blockIds: readonly string[];
  readonly chunkIds: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 质量 Policy 的纯函数输出。 */
export interface QualityEvaluationResult {
  readonly verdict: QualityVerdict;
  readonly metrics: DocumentQualityMetrics;
  readonly findings: readonly QualityFindingDraft[];
}
