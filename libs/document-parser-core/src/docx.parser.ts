/**
 * DOCX Parser：先执行 OOXML 容器安全检查，再用 Mammoth 恢复段落/标题/列表/表格 HTML，
 * 最后映射为统一 Block，并为 `word/media` 图片产生 OCR 候选。
 * Mammoth 只做内容转换；宏、外链、嵌入对象、压缩比和格式真伪以 safe-ooxml 的事实为准。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 */
import * as mammoth from 'mammoth';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, throwIfAborted } from './types';
import { parseHtmlStructure } from './html-structure';
import { readSafeOfficeArchive } from './safe-ooxml';
import { readImageDimensions, type SafeImageDimensions } from './image-dimensions';

/** 现代 Word OOXML Parser。 */
export class DocxDocumentParser implements DocumentFormatParser {
  public readonly format = 'DOCX' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
  ): Promise<FormatParseOutput> {
    const archive = await readSafeOfficeArchive(input.bytes, 'DOCX', limits, signal);
    throwIfAborted(signal);
    let conversion: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
    try {
      conversion = await mammoth.convertToHtml(
        { buffer: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) },
        {
          // 图片正文不嵌入 Parser JSON；只保留占位，真实字节由 archiveEntryPath 定位。
          convertImage: mammoth.images.imgElement(async () => ({
            src: 'about:blank#embedded-image',
          })),
        },
      );
    } catch (error) {
      throw new DocumentParserError('DOCX_CONTENT_INVALID', 'DOCX 文档结构无法解析', {
        cause: error,
      });
    }
    const structure = parseHtmlStructure(conversion.value);
    const mediaEntries = archive.entryNames.filter((name) => name.startsWith('word/media/'));
    let totalPixels = 0;
    const ocrCandidates = mediaEntries.map((entryName, index) => {
      const mediaBytes = archive.entries.get(entryName);
      const dimensions = mediaBytes ? safeImageSize(mediaBytes) : undefined;
      if (dimensions?.width && dimensions.height)
        totalPixels += dimensions.width * dimensions.height;
      return {
        targetId: `docx-image-${index + 1}`,
        kind: 'EMBEDDED_IMAGE' as const,
        pageNo: null,
        slideNo: null,
        sheetName: null,
        bbox: null,
        assetRef: {
          storage: 'SOURCE_ARCHIVE_ENTRY' as const,
          archiveEntryPath: entryName,
          mediaType: mediaTypeFromName(entryName),
        },
        reason: 'EMBEDDED_SCREENSHOT' as const,
      };
    });
    const tableCellCount = structure.tableCellCount;
    if (tableCellCount > limits.maxTableCells) {
      throw new DocumentParserError('TABLE_CELL_LIMIT_EXCEEDED', 'DOCX 表格单元格数量超过安全上限');
    }
    if (totalPixels > limits.maxTotalPixels) {
      throw new DocumentParserError('PIXEL_LIMIT_EXCEEDED', 'DOCX 内嵌图片总像素超过安全上限');
    }

    const imageBlocks = mediaEntries
      .slice(structure.blocks.filter((block) => block.type === 'IMAGE').length)
      .map((entryName, index) =>
        createBlock('IMAGE', '', {
          metadata: {
            extractionSource: 'NATIVE',
            archiveEntryPath: entryName,
            mediaIndex: index + 1,
          },
        }),
      );
    return {
      blocks: [...structure.blocks, ...imageBlocks],
      pages: [],
      ocrCandidates,
      inspection: {
        encrypted: archive.encrypted,
        hasMacros: archive.hasMacros,
        embeddedObjectCount: archive.embeddedObjectCount,
        externalLinkCount: archive.externalLinkCount,
        archiveDepth: archive.archiveDepth,
        compressedSizeBytes: archive.compressedSizeBytes,
        uncompressedSizeBytes: archive.uncompressedSizeBytes,
        pageCount: null,
        totalPixels,
        tableCellCount,
      },
      warnings: [
        ...structure.warnings,
        ...conversion.messages.map((message) => `DOCX_MAMMOTH_${message.type.toUpperCase()}`),
        ...(mediaEntries.length > 0 ? ['DOCX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY'] : []),
      ],
    };
  }
}

/** 图片头损坏不影响原生 DOCX 文本，但会形成可审计警告路径并把像素视为未知。 */
function safeImageSize(bytes: Uint8Array): SafeImageDimensions | undefined {
  try {
    return readImageDimensions(bytes);
  } catch {
    return undefined;
  }
}

/** 根据 OOXML media 后缀提供 OCR 网关可验证的 MIME 提示。 */
function mediaTypeFromName(name: string): string | null {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const types: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return extension ? (types[extension] ?? null) : null;
}
