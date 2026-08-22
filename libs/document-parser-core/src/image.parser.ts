/**
 * 图片元数据 Parser。
 * 它只读取尺寸和类型，不做图像解码或 OCR；整图作为明确 OCR 目标交给可配置 PaddleOCR 服务。
 * 像素上限在 OCR 前执行，避免解压炸弹型图片耗尽内存。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-008
 */
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, emptyInspection } from './types';
import { readImageDimensions } from './image-dimensions';

/** PNG/JPEG/GIF/TIFF/BMP/WebP 图片 Parser。 */
export class ImageDocumentParser implements DocumentFormatParser {
  public readonly format = 'IMAGE' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
  ): Promise<FormatParseOutput> {
    let dimensions: ReturnType<typeof readImageDimensions>;
    try {
      dimensions = readImageDimensions(input.bytes);
    } catch (error) {
      throw new DocumentParserError('IMAGE_HEADER_INVALID', '图片头损坏或格式不受支持', {
        cause: error,
      });
    }
    const width = dimensions.width;
    const height = dimensions.height;
    if (!width || !height)
      throw new DocumentParserError('IMAGE_DIMENSIONS_MISSING', '无法读取图片尺寸');
    const totalPixels = width * height;
    if (!Number.isSafeInteger(totalPixels) || totalPixels > limits.maxTotalPixels) {
      throw new DocumentParserError('PIXEL_LIMIT_EXCEEDED', '图片像素数量超过安全上限');
    }
    return {
      blocks: [
        createBlock('IMAGE', '', {
          pageNo: 1,
          bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
          metadata: {
            extractionSource: 'NATIVE',
            width,
            height,
            imageType: dimensions.type ?? null,
          },
        }),
      ],
      pages: [{ pageNo: 1, textCharacterCount: 0, textCoverage: 0, imageOnly: true }],
      ocrCandidates: [
        {
          targetId: 'whole-image',
          kind: 'WHOLE_IMAGE',
          pageNo: 1,
          slideNo: null,
          sheetName: null,
          bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
          assetRef: {
            storage: 'SOURCE_DOCUMENT',
            archiveEntryPath: null,
            mediaType: input.declaredMime,
          },
          reason: 'IMAGE_ONLY',
        },
      ],
      inspection: { ...emptyInspection(), pageCount: 1, totalPixels, tableCellCount: 0 },
      warnings: [],
    };
  }
}
