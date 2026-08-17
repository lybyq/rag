/**
 * M04 文档结构恢复。
 * 它沿稳定 ordinal 重建标题路径、跨页连续段、条款、FAQ、表格和装饰元素边界，为专用 Chunker 提供输入。
 * 本文件不决定 Token 大小、去重或质量结论。
 *
 * @requirement KNO-002
 * @requirement KNO-005
 */
import type { DocumentBlock } from '@rag/contracts';
import type { StructuredBlock, StructuredBlockKind } from './types';

const clausePattern = /^(?:第[一二三四五六七八九十百千\d]+[编章节条款项]|\d+(?:\.\d+)+[.、\s])/u;
const faqPattern = /^(?:Q|问|问题)\s*[:：]/iu;

/** 按标题栈和格式位置恢复每个 Block 的结构上下文。 */
export function restoreDocumentStructure(
  blocks: readonly DocumentBlock[],
): readonly StructuredBlock[] {
  const headingStack: Array<string | undefined> = [];
  let activeHeadingBoundary = 'document-root';
  let activeFaqBoundary: string | undefined;

  return [...blocks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((block): StructuredBlock => {
      if (block.type === 'TITLE') {
        const level = block.headingLevel ?? 1;
        headingStack.length = level;
        headingStack[level - 1] = block.text.trim() || `未命名标题 ${block.ordinal}`;
        activeHeadingBoundary = `heading:${block.id}`;
        activeFaqBoundary = undefined;
        return structured(block, 'TITLE', compact(headingStack), activeHeadingBoundary, false);
      }

      const headingPath = compact(headingStack);
      if (block.type === 'HEADER' || block.type === 'FOOTER') {
        return structured(block, 'DECORATION', headingPath, `decoration:${block.id}`, false);
      }
      if (block.type === 'FOOTNOTE') {
        return structured(block, 'FOOTNOTE', headingPath, `footnote:${block.id}`, false);
      }
      if (block.type === 'TABLE' || block.type === 'TABLE_ROW') {
        activeFaqBoundary = undefined;
        return structured(
          block,
          'TABLE',
          headingPath,
          `table:${block.parentBlockId ?? block.id}`,
          true,
        );
      }
      if (block.type === 'CODE') {
        activeFaqBoundary = undefined;
        return structured(block, 'CODE', headingPath, `code:${block.id}`, true);
      }
      if (clausePattern.test(block.text.trim())) {
        activeFaqBoundary = undefined;
        return structured(block, 'CLAUSE', headingPath, `clause:${block.id}`, true);
      }
      if (faqPattern.test(block.text.trim())) activeFaqBoundary = `faq:${block.id}`;
      if (activeFaqBoundary) {
        return structured(block, 'FAQ', headingPath, activeFaqBoundary, true);
      }

      const positionalBoundary = block.sheetName
        ? `sheet:${block.sheetName}`
        : block.slideNo
          ? `slide:${block.slideNo}`
          : activeHeadingBoundary;
      const kind: StructuredBlockKind = block.type === 'LIST' ? 'LIST' : 'PROSE';
      return structured(block, kind, headingPath, positionalBoundary, block.text.trim().length > 0);
    });
}

function structured(
  block: DocumentBlock,
  kind: StructuredBlockKind,
  headingPath: readonly string[],
  boundaryKey: string,
  includeInChunk: boolean,
): StructuredBlock {
  return { block, kind, headingPath, boundaryKey, includeInChunk };
}

function compact(values: readonly (string | undefined)[]): readonly string[] {
  return values.filter((value): value is string => Boolean(value));
}
