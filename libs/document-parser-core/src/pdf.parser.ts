/**
 * PDF 原生文字层 Parser。
 * pdf-parse 在 Node/CJS 环境中封装 pdfjs-dist，按页提取文字、链接、页面尺寸和矢量表格；
 * 本实现不渲染页面、不加载远程 CMap/字体、不启用 eval。无可靠文字的页才进入 OCR。
 * pdf-parse 当前不公开字形坐标，因此段落 bbox 按页内行序给出“近似定位”并在 metadata 明示精度，
 * 不能把它冒充字形级坐标；需要像素级引用时由后续可插拔高精度 PDF Adapter 替换。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 */
import { PDFParse, PasswordException } from 'pdf-parse';
import type { OcrTarget, ParsedBlockCandidate, ParsedPage } from '@rag/contracts';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, throwIfAborted } from './types';

/** PDF 文档 Parser。 */
export class PdfDocumentParser implements DocumentFormatParser {
  public readonly format = 'PDF' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const parser = new PDFParse({
      data: input.bytes.slice(),
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      useWorkerFetch: false,
      useWasm: false,
      stopAtErrors: true,
      maxImageSize: limits.maxTotalPixels,
    });
    const onAbort = (): void => {
      void parser.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const info = await parser.getInfo({ parsePageInfo: true });
      if (info.total > limits.maxPages) {
        throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'PDF 页数超过安全上限');
      }
      const text = await parser.getText({ pageJoiner: '', lineEnforce: true });
      // 表格检测失败不应丢失已成功提取的原生文本，但必须留下稳定告警供人工抽查。
      const warnings: string[] = [];
      const tablePages = await parser.getTable().catch(() => {
        warnings.push('PDF_TABLE_DETECTION_FAILED');
        return null;
      });
      throwIfAborted(signal);

      const blocks: ParsedBlockCandidate[] = [];
      const pages: ParsedPage[] = [];
      const ocrCandidates: OcrTarget[] = [];
      let tableCellCount = 0;
      for (let pageNo = 1; pageNo <= info.total; pageNo += 1) {
        throwIfAborted(signal);
        const pageText = text.pages.find((page) => page.num === pageNo)?.text ?? '';
        const lines = pageText.split(/\r?\n/).filter((line) => line.trim().length > 0);
        lines.forEach((line, lineIndex) => {
          const bandHeight = 1 / Math.max(lines.length, 1);
          blocks.push(
            createBlock('PARAGRAPH', line, {
              pageNo,
              bbox: {
                x1: 0,
                y1: lineIndex * bandHeight,
                x2: 1,
                y2: Math.min(1, (lineIndex + 1) * bandHeight),
              },
              metadata: {
                extractionSource: 'NATIVE',
                lineIndex,
                bboxPrecision: 'APPROXIMATE_LINE_ORDER',
              },
            }),
          );
        });
        const detectedTables = tablePages?.pages.find((page) => page.num === pageNo)?.tables ?? [];
        for (const [tableIndex, rows] of detectedTables.entries()) {
          const cells = rows.reduce((sum, row) => sum + row.length, 0);
          tableCellCount += cells;
          if (tableCellCount > limits.maxTableCells) {
            throw new DocumentParserError(
              'TABLE_CELL_LIMIT_EXCEEDED',
              'PDF 表格单元格数量超过安全上限',
            );
          }
          blocks.push(
            createBlock('TABLE', rows.map((row) => row.join(' | ')).join('\n'), {
              pageNo,
              table: { rows, headerRowCount: rows.length > 0 ? 1 : 0, mergedCells: [] },
              metadata: { extractionSource: 'NATIVE', tableIndex, bboxPrecision: 'UNAVAILABLE' },
            }),
          );
        }

        const textCharacterCount = lines.reduce((sum, line) => sum + line.length, 0);
        // pdf-parse 不公开 glyph 面积；以字符密度作为保守覆盖度代理，并明确记录算法修订。
        const textCoverage = Math.min(1, textCharacterCount / 2_000);
        const imageOnly = textCharacterCount === 0;
        pages.push({ pageNo, textCharacterCount, textCoverage, imageOnly });
        // Parser 只报告确定的“无原生文字”；低覆盖阈值属于业务配置，统一由应用层决定，
        // 避免 Parser 的硬编码阈值覆盖 OCR_TEXT_COVERAGE_THRESHOLD。
        if (imageOnly) {
          ocrCandidates.push({
            targetId: `page-${pageNo}`,
            kind: 'PAGE',
            pageNo,
            slideNo: null,
            sheetName: null,
            bbox: null,
            assetRef: {
              storage: 'SOURCE_DOCUMENT',
              archiveEntryPath: null,
              mediaType: 'application/pdf',
            },
            reason: 'NO_NATIVE_TEXT',
          });
        }
      }

      const externalLinkCount = info.pages.reduce((sum, page) => sum + page.links.length, 0);
      const embeddedObjectCount = countAsciiToken(input.bytes, '/EmbeddedFile');
      if (pages.some((page) => page.imageOnly)) warnings.push('PDF_IMAGE_ONLY_PAGES_REQUIRE_OCR');
      if (embeddedObjectCount > 0) warnings.push('PDF_EMBEDDED_FILE_FOUND');
      warnings.push('PDF_BBOX_APPROXIMATE_LINE_ORDER');
      return {
        blocks,
        pages,
        ocrCandidates,
        inspection: {
          encrypted: false,
          hasMacros: false,
          embeddedObjectCount,
          externalLinkCount,
          archiveDepth: null,
          compressedSizeBytes: null,
          uncompressedSizeBytes: null,
          pageCount: info.total,
          totalPixels: null,
          tableCellCount,
        },
        warnings,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof DocumentParserError) throw error;
      throw new DocumentParserError(
        error instanceof PasswordException ? 'PDF_PASSWORD_PROTECTED' : 'PDF_CONTENT_INVALID',
        error instanceof PasswordException ? 'PDF 受密码保护，无法安全解析' : 'PDF 文档结构损坏',
        { cause: error },
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
      await parser.destroy();
    }
  }
}

/** 对 PDF 原始字节做保守 token 计数，只用于发现嵌入文件字典，不解释或执行对象。 */
function countAsciiToken(bytes: Uint8Array, token: string): number {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}
