/**
 * 图片元数据 Parser。
 * 它只读取尺寸和类型，不做图像解码或 OCR；整图作为明确 OCR 目标交给可配置 PaddleOCR 服务。
 * 像素上限在 OCR 前执行，避免解压炸弹型图片耗尽内存。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-008
 * @requirement PAR-023
 */
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, emptyInspection } from './types';
import { inspectImage } from './image-dimensions';
import type { ParseResourceBudget } from './parse-resource-budget';

/** PNG/JPEG/GIF/TIFF/BMP/WebP 图片 Parser。 */
export class ImageDocumentParser implements DocumentFormatParser {
  public readonly format = 'IMAGE' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    _signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    budget.checkpoint();
    let dimensions: ReturnType<typeof inspectImage>;
    try {
      dimensions = inspectImage(input.bytes, limits.maxPages);
    } catch (error) {
      if (error instanceof DocumentParserError) throw error;
      throw new DocumentParserError('IMAGE_HEADER_INVALID', '图片头损坏或格式不受支持', {
        cause: error,
      });
    }
    const width = dimensions.width;
    const height = dimensions.height;
    if (!width || !height)
      throw new DocumentParserError('IMAGE_DIMENSIONS_MISSING', '无法读取图片尺寸');
    // 动画/多页文件可能重复解码同一画布；逐内容单元累计，不能只算首帧像素。
    for (const unit of dimensions.units) budget.consumePixels(unit.width, unit.height);
    if (dimensions.type === 'tiff' && dimensions.unitCount > 1) {
      throw new DocumentParserError(
        'IMAGE_MULTIPAGE_TIFF_UNSUPPORTED',
        '当前版本不解析多页 TIFF；已明确拒绝，避免只入库首页',
      );
    }
    if (dimensions.animated) {
      throw new DocumentParserError(
        'IMAGE_ANIMATION_UNSUPPORTED',
        '当前版本不解析动画图片；已明确拒绝，避免只入库首帧',
      );
    }
    const totalPixels = budget.facts().totalPixels;
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
            contentUnitKind: dimensions.contentUnitKind,
            contentUnitCount: dimensions.unitCount,
            animated: dimensions.animated,
            orientation: dimensions.orientation,
            orientationInspectionComplete: dimensions.orientationInspectionComplete,
            orientationApplied: false,
            storageOrder: dimensions.storageOrder,
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
      warnings: [
        ...(dimensions.orientationInspectionComplete
          ? []
          : ['IMAGE_ORIENTATION_INSPECTION_INCOMPLETE']),
        ...(dimensions.orientation !== null && dimensions.orientation !== 1
          ? ['IMAGE_ORIENTATION_NOT_APPLIED']
          : []),
      ],
    };
  }
}
