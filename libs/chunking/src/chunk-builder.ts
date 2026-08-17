/**
 * M04 结构感知 Chunk 构建器。
 * 它按结构边界选择 prose/table/code/slide/sheet 策略，生成 Parent-Child 与完整来源关系，并执行可逆去重。
 * 本文件只做确定性算法，不写数据库，也不决定最终质量门禁结论。
 *
 * @requirement KNO-003
 * @requirement KNO-004
 * @requirement KNO-005
 * @requirement KNO-006
 * @requirement KNO-007
 * @requirement KNO-008
 */
import type { ChunkContentType, ChunkSourceLocation, DocumentBlock } from '@rag/contracts';
import { createHash } from 'node:crypto';
import { restoreDocumentStructure } from './structure-recovery';
import type {
  BuildKnowledgeChunksInput,
  ChunkingPolicy,
  ChunkRelationDraft,
  KnowledgeChunkBuildResult,
  KnowledgeChunkDraft,
  StructuredBlock,
  TextTokenizer,
} from './types';

interface ChildCandidate {
  readonly sectionKey: string;
  readonly contentType: ChunkContentType;
  readonly displayContent: string;
  readonly headingPath: readonly string[];
  readonly blocks: readonly DocumentBlock[];
  readonly splitReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 构建阶段局部可变；函数返回后仍按 KnowledgeChunkDraft 只读契约暴露。 */
type MutableChunk = {
  -readonly [Key in keyof KnowledgeChunkDraft]: KnowledgeChunkDraft[Key];
};

/** 构建稳定 Chunk 与关系；同一输入、配置和 Tokenizer revision 必须得到同一内容与 ID。 */
export function buildKnowledgeChunks(
  input: BuildKnowledgeChunksInput,
  tokenizer: TextTokenizer,
  policy: ChunkingPolicy,
): KnowledgeChunkBuildResult {
  validatePolicy(policy);
  const structured = restoreDocumentStructure(input.blocks);
  const candidates = buildChildCandidates(structured, input.fileFormat, tokenizer, policy);
  const chunks: MutableChunk[] = [];
  const relations: ChunkRelationDraft[] = [];
  const childChunks: MutableChunk[] = [];
  let ordinal = 1;

  // Parent 以连续 section 为单位分段；超长章节拆成多个 Parent，避免上下文扩展取回无限正文。
  for (const section of groupConsecutive(candidates, (item) => item.sectionKey)) {
    for (const parentBatch of batchForParent(section, tokenizer, policy.parentMaxTokens)) {
      const headingPath = parentBatch[0]?.headingPath ?? [];
      const parentDisplay = parentBatch
        .map((item) => item.displayContent)
        .join('\n\n')
        .trim();
      const parentEmbedding = buildEmbeddingText(headingPath, parentDisplay);
      const parentId = createChunkId(
        input.documentVersionId,
        input.contentRevision,
        'PARENT',
        parentBatch.flatMap((item) => item.blocks).map((item) => item.id),
        parentEmbedding,
      );
      const parent = createDraft({
        id: parentId,
        input,
        ordinal: ordinal++,
        granularity: 'PARENT',
        contentType: parentBatch[0]?.contentType ?? 'PROSE',
        displayContent: parentDisplay,
        embeddingText: parentEmbedding,
        tokenizer,
        headingPath,
        blocks: uniqueBlocks(parentBatch.flatMap((item) => item.blocks)),
        parentChunkId: null,
        splitReason: section.length === parentBatch.length ? null : 'PARENT_TOKEN_LIMIT',
        metadata: { sectionKey: parentBatch[0]?.sectionKey ?? 'document-root' },
      });
      chunks.push(parent);

      for (const candidate of parentBatch) {
        const embeddingText = buildEmbeddingText(candidate.headingPath, candidate.displayContent);
        const child = createDraft({
          id: createChunkId(
            input.documentVersionId,
            input.contentRevision,
            'CHILD',
            candidate.blocks.map((item) => item.id),
            embeddingText,
          ),
          input,
          ordinal: ordinal++,
          granularity: 'CHILD',
          contentType: candidate.contentType,
          displayContent: candidate.displayContent,
          embeddingText,
          tokenizer,
          headingPath: candidate.headingPath,
          blocks: candidate.blocks,
          parentChunkId: parent.id,
          splitReason: candidate.splitReason,
          metadata: candidate.metadata,
        });
        chunks.push(child);
        childChunks.push(child);
        relations.push(relation(child.id, 'PARENT_CHILD', parent.id, null, 0));
        addSourceRelations(relations, child, candidate.blocks);
        addSourceRelations(relations, parent, candidate.blocks);
        if (candidate.contentType === 'TABLE') {
          relations.push(
            relation(child.id, 'TABLE_HEADER', null, candidate.blocks[0]?.id ?? null, 0),
          );
        }
      }
    }
  }

  linkNeighbors(childChunks, relations);
  linkFootnotes(structured, childChunks, relations);
  applyDeduplication(childChunks, relations, policy.dedupMode);
  return { chunks, relations: uniqueRelations(relations) };
}

function buildChildCandidates(
  blocks: readonly StructuredBlock[],
  fileFormat: BuildKnowledgeChunksInput['fileFormat'],
  tokenizer: TextTokenizer,
  policy: ChunkingPolicy,
): readonly ChildCandidate[] {
  const included = blocks.filter((item) => item.includeInChunk);
  const duplicatedAtomicTexts = findDuplicatedAtomicTexts(included);
  const output: ChildCandidate[] = [];
  for (const group of groupConsecutive(
    included,
    (item) => `${item.boundaryKey}:${compatibleKind(item, fileFormat)}`,
  )) {
    const first = group[0];
    if (!first) continue;
    if (first.kind === 'TABLE') {
      output.push(...buildTableCandidates(group, tokenizer, policy.childMaxTokens));
      continue;
    }
    output.push(
      ...buildTextCandidates(group, fileFormat, tokenizer, policy, duplicatedAtomicTexts),
    );
  }
  return output;
}

function buildTableCandidates(
  group: readonly StructuredBlock[],
  tokenizer: TextTokenizer,
  maxTokens: number,
): readonly ChildCandidate[] {
  const candidates: ChildCandidate[] = [];
  for (const item of group) {
    const table = item.block.table;
    if (!table) {
      candidates.push(...splitAtomic(item, 'TABLE', tokenizer, maxTokens, 0));
      continue;
    }
    const headerRows = table.rows.slice(0, table.headerRowCount);
    const dataRows = table.rows.slice(table.headerRowCount);
    const headerText = headerRows.map(renderTableRow).join('\n');
    const rows = dataRows.length > 0 ? dataRows : headerRows;
    let currentRows: string[] = [];
    const flush = (): void => {
      if (currentRows.length === 0) return;
      const display = [headerText, ...currentRows].filter(Boolean).join('\n');
      candidates.push({
        sectionKey: item.boundaryKey,
        contentType: 'TABLE',
        displayContent: display,
        headingPath: item.headingPath,
        blocks: [item.block],
        splitReason: rows.length === currentRows.length ? null : 'TABLE_ROW_GROUP',
        metadata: { headerRowCount: table.headerRowCount, mergedCells: table.mergedCells },
      });
      currentRows = [];
    };
    for (const row of rows) {
      const rendered = renderTableRow(row);
      const attempted = [headerText, ...currentRows, rendered].filter(Boolean).join('\n');
      const embedding = buildEmbeddingText(item.headingPath, attempted);
      if (currentRows.length > 0 && tokenizer.count(embedding) > maxTokens) flush();
      const single = [headerText, rendered].filter(Boolean).join('\n');
      if (tokenizer.count(buildEmbeddingText(item.headingPath, single)) > maxTokens) {
        flush();
        for (const part of tokenizer.split(
          single,
          availableTextTokens(item.headingPath, maxTokens, tokenizer),
          0,
        )) {
          candidates.push({
            sectionKey: item.boundaryKey,
            contentType: 'TABLE',
            displayContent: part,
            headingPath: item.headingPath,
            blocks: [item.block],
            splitReason: 'TOKEN_LIMIT',
            metadata: { headerRowCount: table.headerRowCount, mergedCells: table.mergedCells },
          });
        }
      } else currentRows.push(rendered);
    }
    flush();
  }
  return candidates;
}

function buildTextCandidates(
  group: readonly StructuredBlock[],
  fileFormat: BuildKnowledgeChunksInput['fileFormat'],
  tokenizer: TextTokenizer,
  policy: ChunkingPolicy,
  duplicatedAtomicTexts: ReadonlySet<string>,
): readonly ChildCandidate[] {
  const first = group[0];
  if (!first) return [];
  const contentType = contentTypeFor(first, fileFormat);
  const output: ChildCandidate[] = [];
  let current: StructuredBlock[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    output.push({
      sectionKey: first.boundaryKey,
      contentType,
      displayContent: current
        .map((item) => item.block.text)
        .join('\n\n')
        .trim(),
      headingPath: first.headingPath,
      blocks: current.map((item) => item.block),
      splitReason: current.length === group.length ? null : 'TOKEN_LIMIT',
      metadata: positionalMetadata(current.map((item) => item.block)),
    });
    current = [];
  };

  for (const item of group) {
    // 重复 Block 必须先成为独立候选，否则两份连续页脚会被合并成一个 Chunk，
    // 后续基于完整 Chunk 的 Hash 将无法识别“同一内容出现于两个来源页”。
    if (duplicatedAtomicTexts.has(canonicalize(item.block.text))) {
      flush();
      const atomicEmbedding = buildEmbeddingText(item.headingPath, item.block.text);
      if (tokenizer.count(atomicEmbedding) > policy.childMaxTokens) {
        output.push(
          ...splitAtomic(
            item,
            contentTypeFor(item, fileFormat),
            tokenizer,
            policy.childMaxTokens,
            policy.overlapTokens,
          ),
        );
      } else {
        output.push({
          sectionKey: item.boundaryKey,
          contentType: contentTypeFor(item, fileFormat),
          displayContent: item.block.text.trim(),
          headingPath: item.headingPath,
          blocks: [item.block],
          splitReason: null,
          metadata: positionalMetadata([item.block]),
        });
      }
      continue;
    }
    const attempted = [...current, item].map((entry) => entry.block.text).join('\n\n');
    if (
      current.length > 0 &&
      tokenizer.count(buildEmbeddingText(first.headingPath, attempted)) > policy.childMaxTokens
    ) {
      flush();
    }
    const atomicEmbedding = buildEmbeddingText(first.headingPath, item.block.text);
    if (tokenizer.count(atomicEmbedding) > policy.childMaxTokens) {
      flush();
      output.push(
        ...splitAtomic(item, contentType, tokenizer, policy.childMaxTokens, policy.overlapTokens),
      );
    } else current.push(item);
  }
  flush();
  return output;
}

/** 返回在整份文档中出现至少两次的规范化原子正文。 */
function findDuplicatedAtomicTexts(blocks: readonly StructuredBlock[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const item of blocks) {
    const normalized = canonicalize(item.block.text);
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([normalized]) => normalized),
  );
}

function splitAtomic(
  item: StructuredBlock,
  contentType: ChunkContentType,
  tokenizer: TextTokenizer,
  maxTokens: number,
  overlapTokens: number,
): readonly ChildCandidate[] {
  const parts = splitWithinEmbeddingBudget(
    item.block.text,
    item.headingPath,
    maxTokens,
    overlapTokens,
    tokenizer,
  );
  return parts.map((part) => ({
    sectionKey: item.boundaryKey,
    contentType,
    displayContent: part,
    headingPath: item.headingPath,
    blocks: [item.block],
    splitReason: 'TOKEN_LIMIT',
    metadata: positionalMetadata([item.block]),
  }));
}

function batchForParent(
  section: readonly ChildCandidate[],
  tokenizer: TextTokenizer,
  maxTokens: number,
): readonly (readonly ChildCandidate[])[] {
  const batches: ChildCandidate[][] = [];
  let current: ChildCandidate[] = [];
  for (const child of section) {
    const attempted = [...current, child].map((item) => item.displayContent).join('\n\n');
    if (
      current.length > 0 &&
      tokenizer.count(buildEmbeddingText(child.headingPath, attempted)) > maxTokens
    ) {
      batches.push(current);
      current = [];
    }
    current.push(child);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function createDraft(input: {
  readonly id: string;
  readonly input: BuildKnowledgeChunksInput;
  readonly ordinal: number;
  readonly granularity: 'PARENT' | 'CHILD';
  readonly contentType: ChunkContentType;
  readonly displayContent: string;
  readonly embeddingText: string;
  readonly tokenizer: TextTokenizer;
  readonly headingPath: readonly string[];
  readonly blocks: readonly DocumentBlock[];
  readonly parentChunkId: string | null;
  readonly splitReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}): MutableChunk {
  return {
    id: input.id,
    documentVersionId: input.input.documentVersionId,
    contentRevision: input.input.contentRevision,
    ordinal: input.ordinal,
    granularity: input.granularity,
    contentType: input.contentType,
    displayContent: input.displayContent,
    embeddingText: input.embeddingText,
    tokenCount: input.tokenizer.count(input.embeddingText),
    tokenizerProfileId: input.tokenizer.profileId,
    tokenizerRevision: input.tokenizer.revision,
    headingPath: input.headingPath,
    sourceLocations: uniqueLocations(input.blocks.map(sourceLocation)),
    parentChunkId: input.parentChunkId,
    contentSha256: sha256(input.embeddingText),
    dedupStatus: 'UNIQUE',
    duplicateOfChunkId: null,
    eligibleForIndex: false,
    splitReason: input.splitReason,
    metadata: input.metadata,
  };
}

function applyDeduplication(
  chunks: readonly MutableChunk[],
  relations: ChunkRelationDraft[],
  mode: ChunkingPolicy['dedupMode'],
): void {
  const firstByHash = new Map<string, MutableChunk>();
  for (const chunk of chunks) {
    const canonicalHash = sha256(canonicalize(chunk.displayContent));
    const original = firstByHash.get(canonicalHash);
    if (!original) {
      firstByHash.set(canonicalHash, chunk);
      continue;
    }
    chunk.dedupStatus = mode === 'SUPPRESS' ? 'SUPPRESSED_DUPLICATE' : 'RETAINED_DUPLICATE';
    chunk.duplicateOfChunkId = original.id;
    relations.push(
      relation(chunk.id, 'DUPLICATE_OF', original.id, null, 0, {
        scope: duplicateScope(original, chunk),
      }),
    );
  }
}

function linkNeighbors(chunks: readonly MutableChunk[], relations: ChunkRelationDraft[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const current = chunks[index];
    if (!current) continue;
    const previous = chunks[index - 1];
    const next = chunks[index + 1];
    if (previous) relations.push(relation(current.id, 'PREVIOUS', previous.id, null, 0));
    if (next) relations.push(relation(current.id, 'NEXT', next.id, null, 0));
  }
}

function linkFootnotes(
  structured: readonly StructuredBlock[],
  chunks: readonly MutableChunk[],
  relations: ChunkRelationDraft[],
): void {
  for (const footnote of structured.filter((item) => item.kind === 'FOOTNOTE')) {
    const target = [...chunks]
      .reverse()
      .find((chunk) =>
        chunk.sourceLocations.some((location) => location.pageNo === footnote.block.pageNo),
      );
    if (target) relations.push(relation(target.id, 'FOOTNOTE', null, footnote.block.id, 0));
  }
}

function addSourceRelations(
  relations: ChunkRelationDraft[],
  chunk: MutableChunk,
  blocks: readonly DocumentBlock[],
): void {
  for (const [index, block] of uniqueBlocks(blocks).entries()) {
    relations.push(relation(chunk.id, 'SOURCE_BLOCK', null, block.id, index));
  }
}

function relation(
  fromChunkId: string,
  relationType: ChunkRelationDraft['relationType'],
  toChunkId: string | null,
  toBlockId: string | null,
  ordinal: number,
  metadata: Readonly<Record<string, unknown>> = {},
): ChunkRelationDraft {
  if ((toChunkId === null) === (toBlockId === null)) throw new Error('关系目标必须且只能指定一个');
  return { fromChunkId, relationType, toChunkId, toBlockId, ordinal, metadata };
}

function uniqueRelations(relations: readonly ChunkRelationDraft[]): readonly ChunkRelationDraft[] {
  const seen = new Set<string>();
  return relations.filter((item) => {
    const key = `${item.fromChunkId}:${item.relationType}:${item.toChunkId ?? item.toBlockId}:${item.ordinal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildEmbeddingText(headingPath: readonly string[], displayContent: string): string {
  const heading = headingPath.length > 0 ? `标题路径：${headingPath.join(' > ')}` : '';
  return [heading, displayContent.trim()].filter(Boolean).join('\n');
}

function availableTextTokens(
  headingPath: readonly string[],
  maxTokens: number,
  tokenizer: TextTokenizer,
): number {
  const prefixTokens = tokenizer.count(buildEmbeddingText(headingPath, ''));
  return Math.max(1, maxTokens - prefixTokens);
}

/**
 * 按“最终 embeddingText”而不是裸正文校验 token 上限。
 *
 * BPE 会跨字符串拼接边界重新合并 token，所以“总预算减去标题 token 数”最多只是初始估计，
 * 不能数学上保证 `标题 + 换行 + 正文` 仍不超限。这里从估计值逐步收紧正文预算，直到每一段
 * 拼回完整 embeddingText 后都满足硬上限；因此代码、中文和中英混排使用同一条可靠规则。
 */
function splitWithinEmbeddingBudget(
  text: string,
  headingPath: readonly string[],
  maxTokens: number,
  overlapTokens: number,
  tokenizer: TextTokenizer,
): readonly string[] {
  const initialBudget = availableTextTokens(headingPath, maxTokens, tokenizer);
  for (let textBudget = initialBudget; textBudget >= 1; textBudget -= 1) {
    const safeOverlap = Math.min(overlapTokens, Math.max(0, textBudget - 1));
    const parts = tokenizer.split(text, textBudget, safeOverlap);
    if (
      parts.every((part) => tokenizer.count(buildEmbeddingText(headingPath, part)) <= maxTokens)
    ) {
      return parts;
    }
  }

  // 即便正文只剩一个 token 仍放不下，说明标题上下文本身已经吃满预算。
  // 静默产出超长 Chunk 会把故障推迟到 Embedding 阶段，因此在知识加工阶段明确失败更安全。
  throw new Error(`标题路径占用过多 token，无法满足 childMaxTokens=${maxTokens}`);
}

function compatibleKind(
  item: StructuredBlock,
  fileFormat: BuildKnowledgeChunksInput['fileFormat'],
): string {
  if (
    item.kind === 'TABLE' ||
    item.kind === 'CODE' ||
    item.kind === 'CLAUSE' ||
    item.kind === 'FAQ'
  ) {
    return item.kind;
  }
  if (fileFormat === 'PPTX') return 'SLIDE';
  if (fileFormat === 'XLSX' || fileFormat === 'CSV') return 'SHEET';
  return item.kind;
}

function contentTypeFor(
  item: StructuredBlock,
  fileFormat: BuildKnowledgeChunksInput['fileFormat'],
): ChunkContentType {
  if (item.kind === 'CODE') return 'CODE';
  if (item.kind === 'CLAUSE') return 'CLAUSE';
  if (item.kind === 'FAQ') return 'FAQ';
  if (item.kind === 'LIST') return 'LIST';
  if (fileFormat === 'PPTX') return 'SLIDE';
  if (fileFormat === 'XLSX' || fileFormat === 'CSV') return 'SHEET';
  return 'PROSE';
}

function sourceLocation(block: DocumentBlock): ChunkSourceLocation {
  return {
    blockId: block.id,
    pageNo: block.pageNo,
    sheetName: block.sheetName,
    slideNo: block.slideNo,
    bbox: block.bbox,
  };
}

function uniqueLocations(
  locations: readonly ChunkSourceLocation[],
): readonly ChunkSourceLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    if (seen.has(location.blockId)) return false;
    seen.add(location.blockId);
    return true;
  });
}

function uniqueBlocks(blocks: readonly DocumentBlock[]): readonly DocumentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    if (seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
}

function positionalMetadata(blocks: readonly DocumentBlock[]): Readonly<Record<string, unknown>> {
  return {
    pageFrom: minimum(blocks.map((item) => item.pageNo)),
    pageTo: maximum(blocks.map((item) => item.pageNo)),
    sheetNames: [...new Set(blocks.flatMap((item) => (item.sheetName ? [item.sheetName] : [])))],
    slideFrom: minimum(blocks.map((item) => item.slideNo)),
    slideTo: maximum(blocks.map((item) => item.slideNo)),
  };
}

function minimum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

function maximum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function renderTableRow(row: readonly string[]): string {
  return `| ${row.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`;
}

function canonicalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
}

function createChunkId(
  documentVersionId: string,
  contentRevision: number,
  granularity: string,
  blockIds: readonly string[],
  text: string,
): string {
  const digest = sha256(
    [documentVersionId, String(contentRevision), granularity, ...blockIds, sha256(text)].join(
      '\u001f',
    ),
  );
  return `chunk:${digest}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function duplicateScope(
  original: MutableChunk,
  duplicate: MutableChunk,
): 'SAME_PAGE' | 'CROSS_PAGE' {
  const originalPages = new Set(original.sourceLocations.map((item) => item.pageNo));
  return duplicate.sourceLocations.some((item) => originalPages.has(item.pageNo))
    ? 'SAME_PAGE'
    : 'CROSS_PAGE';
}

function groupConsecutive<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): readonly (readonly T[])[] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentKey: string | undefined;
  for (const value of values) {
    const key = keyOf(value);
    if (current.length > 0 && key !== currentKey) {
      groups.push(current);
      current = [];
    }
    currentKey = key;
    current.push(value);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function validatePolicy(policy: ChunkingPolicy): void {
  if (policy.childMaxTokens < 8) throw new Error('childMaxTokens 不能小于 8');
  if (policy.parentMaxTokens < policy.childMaxTokens) {
    throw new Error('parentMaxTokens 不能小于 childMaxTokens');
  }
  if (policy.overlapTokens < 0 || policy.overlapTokens >= policy.childMaxTokens) {
    throw new Error('overlapTokens 必须位于 [0, childMaxTokens)');
  }
}
