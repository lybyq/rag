/**
 * 把 Parser/OCR 候选项转换为稳定、可定位的 Block 草稿。
 * 本层只做纯函数规范化和稳定标识，不写数据库，也不生成 M04 的 Chunk。
 *
 * @requirement PAR-007
 * @requirement PAR-008
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-012
 */
import type { ParsedBlockCandidate, ParsedPage } from '@rag/contracts';
import { createHash } from 'node:crypto';

/** 持久化前的 Block 草稿；createdAt 由 PostgreSQL 统一产生。 */
export interface DocumentBlockDraft extends ParsedBlockCandidate {
  readonly id: string;
  readonly parseRunId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly ordinal: number;
  readonly parentBlockId: string | null;
  readonly parserName: string;
  readonly parserRevision: string;
  readonly ocrEngine: string | null;
  readonly ocrRevision: string | null;
  readonly contentSha256: string;
}

/** 构建 Block 所需的版本化上下文。 */
export interface BuildDocumentBlocksInput {
  readonly parseRunId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly parserName: string;
  readonly parserRevision: string;
  readonly ocrEngine?: string;
  readonly ocrRevision?: string;
  readonly candidates: readonly ParsedBlockCandidate[];
}

/** 统一换行和行内空白，但绝不修改 originalText。 */
export function normalizeBlockText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** SHA-256 始终返回小写十六进制，供 PG CHECK 和 MinIO metadata 共同验证。 */
export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 为当前候选顺序生成从 1 开始的 ordinal 和稳定 ID。
 * ID 包含内容修订和 ordinal，因此同一修订重试稳定，不同修订不会错误覆盖。
 */
export function buildDocumentBlocks(
  input: BuildDocumentBlocksInput,
): readonly DocumentBlockDraft[] {
  return input.candidates.map((candidate, index) => {
    const ordinal = index + 1;
    const text = normalizeBlockText(candidate.text);
    const contentSha256 = sha256Text(
      JSON.stringify({
        type: candidate.type,
        text,
        originalText: candidate.originalText,
        pageNo: candidate.pageNo,
        sheetName: candidate.sheetName,
        slideNo: candidate.slideNo,
        bbox: candidate.bbox,
        table: candidate.table,
      }),
    );
    const stableSuffix = sha256Text(
      `${input.documentVersionId}:${input.contentRevision}:${ordinal}:${contentSha256}`,
    ).slice(0, 32);
    return {
      ...candidate,
      text,
      id: `block-${stableSuffix}`,
      parseRunId: input.parseRunId,
      documentVersionId: input.documentVersionId,
      contentRevision: input.contentRevision,
      ordinal,
      parentBlockId: null,
      parserName: input.parserName,
      parserRevision: input.parserRevision,
      ocrEngine: input.ocrEngine ?? null,
      ocrRevision: input.ocrRevision ?? null,
      contentSha256,
    };
  });
}

/** 只选择低文字覆盖或明确纯图片页，并稳定去重排序。 */
export function selectOcrPages(
  pages: readonly ParsedPage[],
  textCoverageThreshold: number,
): readonly number[] {
  return [
    ...new Set(
      pages
        .filter((page) => page.imageOnly || page.textCoverage < textCoverageThreshold)
        .map((page) => page.pageNo),
    ),
  ].sort((left, right) => left - right);
}

/** OCR 页替换同页原生候选，可靠文字页保持 Parser 原结果。 */
export function mergeOcrBlocks(
  parserBlocks: readonly ParsedBlockCandidate[],
  ocrBlocks: readonly ParsedBlockCandidate[],
  ocrPageNumbers: readonly number[],
): readonly ParsedBlockCandidate[] {
  const replacedPages = new Set(ocrPageNumbers);
  const native = parserBlocks.filter(
    (block) => block.pageNo === null || !replacedPages.has(block.pageNo),
  );
  return [...native, ...ocrBlocks].sort(compareBlockLocation);
}

/** 阅读顺序优先页/Slide，再按坐标；无坐标项保持 Provider 原始稳定顺序。 */
function compareBlockLocation(left: ParsedBlockCandidate, right: ParsedBlockCandidate): number {
  const leftPage = left.pageNo ?? left.slideNo ?? Number.MAX_SAFE_INTEGER;
  const rightPage = right.pageNo ?? right.slideNo ?? Number.MAX_SAFE_INTEGER;
  if (leftPage !== rightPage) return leftPage - rightPage;
  if (left.bbox && right.bbox) {
    if (left.bbox.y1 !== right.bbox.y1) return left.bbox.y1 - right.bbox.y1;
    return left.bbox.x1 - right.bbox.x1;
  }
  return 0;
}

/** derived Key 只包含服务端 ID、修订和净化 Profile，不含用户文件名。 */
export function buildDerivedSnapshotKey(
  documentVersionId: string,
  contentRevision: number,
  parserProfileId: string,
): string {
  const safeProfile = parserProfileId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  if (!safeProfile) throw new Error('parserProfileId 净化后为空');
  return `derived/${documentVersionId}/content-r${contentRevision}/parser-${safeProfile}/blocks.json`;
}
