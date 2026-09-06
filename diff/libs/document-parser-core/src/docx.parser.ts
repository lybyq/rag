/**
 * DOCX Parser：先执行 OOXML 容器安全检查，再恢复正文结构与 drawing relationship。
 * Mammoth 负责段落、列表和表格到 HTML；本文件负责把每次图片出现关联到真实 word/media 资产和正文锚点。
 * 未经排版不能得到可靠物理页码/bbox，因此这些字段保持 null；页眉页脚等边界能力必须告警。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-017
 * @requirement PAR-021
 */
import * as mammoth from 'mammoth';
import { load } from 'cheerio';
import { posix } from 'node:path';
import type { OcrTarget, ParsedBlockCandidate } from '@rag/contracts';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, throwIfAborted } from './types';
import { parseHtmlStructure } from './html-structure';
import { readSafeOfficeArchive } from './safe-ooxml';
import { readImageDimensions } from './image-dimensions';
import type { ParseResourceBudget } from './parse-resource-budget';

/** 正文中一次图片引用；多个 occurrence 可以指向同一个 entryPath 资产。 */
interface DocxImageOccurrence {
  readonly occurrenceIndex: number;
  readonly targetId: string;
  readonly relationshipId: string;
  readonly entryPath: string;
  readonly paragraphIndex: number;
  readonly drawingIndexInParagraph: number;
  readonly anchorKind: 'INLINE' | 'FLOATING' | 'VML' | 'UNKNOWN';
  readonly alternative: string;
}

/** 文档关系的安全内部目标。 */
interface DocxRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

/** 现代 Word OOXML Parser。 */
export class DocxDocumentParser implements DocumentFormatParser {
  public readonly format = 'DOCX' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    const archive = await readSafeOfficeArchive(input.bytes, 'DOCX', limits, signal);
    throwIfAborted(signal);
    const warnings = new Set<string>();
    const documentBytes = archive.entries.get('word/document.xml');
    if (!documentBytes) {
      throw new DocumentParserError('DOCX_DOCUMENT_XML_MISSING', 'DOCX 正文 XML 缺失');
    }

    const relationships = readDocumentRelationships(archive.entries);
    const occurrences = readImageOccurrences(documentBytes, relationships, archive.entries);
    collectDocxBoundaryWarnings(archive.entryNames, documentBytes, warnings);
    const styleMap = buildMammothStyleMap(archive.entries.get('word/styles.xml'), warnings);

    let callbackIndex = 0;
    let conversion: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
    try {
      conversion = await mammoth.convertToHtml(
        { buffer: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) },
        {
          styleMap: [...styleMap],
          // Mammoth 保持正文图片出现顺序。内部 fragment 穿过 HTML 层后再与已验证 relationship 对齐；
          // 真实字节不转 Base64、不进入 JSON，也不会产生外部网络请求。
          convertImage: mammoth.images.imgElement(async () => {
            callbackIndex += 1;
            if (callbackIndex > occurrences.length) warnings.add('DOCX_IMAGE_OCCURRENCE_UNMAPPED');
            return { src: `about:blank#docx-image-occurrence-${callbackIndex}` };
          }),
          externalFileAccess: false,
        },
      );
    } catch (error) {
      throw new DocumentParserError('DOCX_CONTENT_INVALID', 'DOCX 文档结构无法解析', {
        cause: error,
      });
    }
    budget.checkpoint();

    const structure = parseHtmlStructure(conversion.value, budget);
    const blocks = attachImageOccurrences(structure.blocks, occurrences, budget, warnings);
    const ocrCandidates = buildOcrCandidates(occurrences, archive.entries, budget, warnings);
    const referencedAssets = new Set(occurrences.map((occurrence) => occurrence.entryPath));
    const unreferencedMedia = archive.entryNames.some(
      (name) => name.startsWith('word/media/') && !referencedAssets.has(name),
    );
    if (unreferencedMedia) warnings.add('DOCX_UNREFERENCED_MEDIA_IGNORED');
    if (ocrCandidates.length > 0) warnings.add('DOCX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY');

    return {
      blocks,
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
        totalPixels: budget.facts().totalPixels,
        tableCellCount: budget.facts().actualTableCells,
      },
      warnings: [
        ...structure.warnings,
        ...conversion.messages.map((message) => `DOCX_MAMMOTH_${message.type.toUpperCase()}`),
        ...warnings,
      ],
    };
  }
}

/** 读取 document.xml.rels；正文图片只接受指向归档内部 word/media 的关系。 */
function readDocumentRelationships(
  entries: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, DocxRelationship> {
  const bytes = entries.get('word/_rels/document.xml.rels');
  if (!bytes) return new Map();
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const result = new Map<string, DocxRelationship>();
  $('Relationship').each((_index, element) => {
    const node = $(element);
    if (node.attr('TargetMode')?.toLowerCase() === 'external') return;
    const id = node.attr('Id');
    const target = node.attr('Target');
    if (!id || !target) return;
    const normalized = posix.normalize(posix.join('word', target));
    if (normalized.startsWith('../') || posix.isAbsolute(normalized)) return;
    result.set(id, { id, type: node.attr('Type') ?? '', target: normalized });
  });
  return result;
}

/**
 * 按正文 XML 顺序读取 DrawingML/VML 图片，并把关系、段落和段内序号冻结为稳定锚点。
 * 找不到关系时直接拒绝，绝不拿 word/media 的第 N 个文件猜测。
 */
function readImageOccurrences(
  documentBytes: Uint8Array,
  relationships: ReadonlyMap<string, DocxRelationship>,
  entries: ReadonlyMap<string, Uint8Array>,
): readonly DocxImageOccurrence[] {
  const $ = load(new TextDecoder().decode(documentBytes), { xmlMode: true });
  const body = $('w\\:body').first();
  const paragraphs = body.find('w\\:p').toArray();
  const paragraphIndexByNode = new Map(
    paragraphs.map((paragraph, index) => [paragraph, index + 1]),
  );
  const paragraphOccurrenceCounts = new Map<number, number>();
  const occurrences: DocxImageOccurrence[] = [];

  const imageNodes = body.find('a\\:blip[r\\:embed],v\\:imagedata[r\\:id]').toArray();
  for (const element of imageNodes) {
    const node = $(element);
    const relationshipId = node.attr('r:embed') ?? node.attr('r:id');
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (
      !relationshipId ||
      !relationship ||
      !relationship.target.startsWith('word/media/') ||
      !entries.has(relationship.target)
    ) {
      throw new DocumentParserError(
        'DOCX_IMAGE_RELATIONSHIP_MISSING',
        'DOCX 正文图片缺少有效的内部媒体关系',
      );
    }
    const paragraph = node.parents('w\\:p').first();
    const paragraphIndex = paragraphIndexByNode.get(paragraph.get(0)!) ?? 0;
    const drawingIndexInParagraph = (paragraphOccurrenceCounts.get(paragraphIndex) ?? 0) + 1;
    paragraphOccurrenceCounts.set(paragraphIndex, drawingIndexInParagraph);
    const occurrenceIndex = occurrences.length + 1;
    const drawing = node.parents('w\\:drawing,w\\:pict').first();
    const properties = drawing.find('wp\\:docPr').first();
    occurrences.push({
      occurrenceIndex,
      targetId: `docx-image-occurrence-${occurrenceIndex}`,
      relationshipId,
      entryPath: relationship.target,
      paragraphIndex,
      drawingIndexInParagraph,
      anchorKind: readAnchorKind(node),
      alternative:
        properties.attr('descr') ?? properties.attr('title') ?? properties.attr('name') ?? '',
    });
  }
  return occurrences;
}

/** 为 HTML 产生的 IMAGE Block 补真实关系；Mammoth 未呈现的 occurrence 仍保留占位并告警。 */
function attachImageOccurrences(
  sourceBlocks: readonly ParsedBlockCandidate[],
  occurrences: readonly DocxImageOccurrence[],
  budget: ParseResourceBudget,
  warnings: Set<string>,
): readonly ParsedBlockCandidate[] {
  const byReference = new Map(
    occurrences.map((occurrence) => [
      `docx-image-occurrence-${occurrence.occurrenceIndex}`,
      occurrence,
    ]),
  );
  const used = new Set<number>();
  const blocks = sourceBlocks.map((block) => {
    if (block.type !== 'IMAGE') return block;
    const sourceReference = block.metadata.sourceReference;
    const occurrence =
      typeof sourceReference === 'string' ? byReference.get(sourceReference) : undefined;
    if (!occurrence) {
      warnings.add('DOCX_IMAGE_OCCURRENCE_UNMAPPED');
      return block;
    }
    used.add(occurrence.occurrenceIndex);
    const text = block.originalText || occurrence.alternative;
    return {
      ...block,
      text,
      originalText: text,
      pageNo: null,
      bbox: null,
      metadata: {
        ...block.metadata,
        archiveEntryPath: occurrence.entryPath,
        ocrTargetId: occurrence.targetId,
        occurrenceIndex: occurrence.occurrenceIndex,
        paragraphIndex: occurrence.paragraphIndex,
        drawingIndexInParagraph: occurrence.drawingIndexInParagraph,
        anchorKind: occurrence.anchorKind,
        relationshipId: occurrence.relationshipId,
      },
    };
  });

  for (const occurrence of occurrences) {
    if (used.has(occurrence.occurrenceIndex)) continue;
    warnings.add('DOCX_IMAGE_OCCURRENCE_NOT_RENDERED');
    budget.consumeOutputCharacters(occurrence.alternative.length);
    blocks.push(
      createBlock('IMAGE', occurrence.alternative, {
        pageNo: null,
        bbox: null,
        metadata: {
          extractionSource: 'NATIVE',
          archiveEntryPath: occurrence.entryPath,
          ocrTargetId: occurrence.targetId,
          occurrenceIndex: occurrence.occurrenceIndex,
          paragraphIndex: occurrence.paragraphIndex,
          drawingIndexInParagraph: occurrence.drawingIndexInParagraph,
          anchorKind: occurrence.anchorKind,
          relationshipId: occurrence.relationshipId,
        },
      }),
    );
  }
  return blocks;
}

/** 每次图片出现生成一个 OCR Target；像素预算只按唯一资产累计，重复引用不重复解码。 */
function buildOcrCandidates(
  occurrences: readonly DocxImageOccurrence[],
  entries: ReadonlyMap<string, Uint8Array>,
  budget: ParseResourceBudget,
  warnings: Set<string>,
): readonly OcrTarget[] {
  const measuredAssets = new Set<string>();
  for (const occurrence of occurrences) {
    if (measuredAssets.has(occurrence.entryPath)) continue;
    measuredAssets.add(occurrence.entryPath);
    const mediaBytes = entries.get(occurrence.entryPath);
    if (!mediaBytes) continue;
    try {
      const dimensions = readImageDimensions(mediaBytes);
      if (dimensions.width && dimensions.height) {
        budget.consumePixels(dimensions.width, dimensions.height);
      } else {
        warnings.add('DOCX_IMAGE_DIMENSIONS_UNREADABLE');
      }
    } catch {
      warnings.add('DOCX_IMAGE_DIMENSIONS_UNREADABLE');
    }
    if (!mediaTypeFromName(occurrence.entryPath)) warnings.add('DOCX_IMAGE_FORMAT_UNSUPPORTED');
  }

  return occurrences.map((occurrence) => ({
    targetId: occurrence.targetId,
    kind: 'EMBEDDED_IMAGE',
    pageNo: null,
    slideNo: null,
    sheetName: null,
    bbox: null,
    assetRef: {
      storage: 'SOURCE_ARCHIVE_ENTRY',
      archiveEntryPath: occurrence.entryPath,
      mediaType: mediaTypeFromName(occurrence.entryPath),
    },
    reason: 'EMBEDDED_SCREENSHOT',
  }));
}

/** 从自定义段落样式的 outlineLvl 恢复标题；无可靠层级的样式仍交给 Mammoth 普通段落策略。 */
function buildMammothStyleMap(
  stylesBytes: Uint8Array | undefined,
  warnings: Set<string>,
): readonly string[] {
  if (!stylesBytes) return [];
  const $ = load(new TextDecoder().decode(stylesBytes), { xmlMode: true });
  const definitions = new Map<
    string,
    { readonly basedOn: string | null; readonly outlineLevel: number | null }
  >();
  $('w\\:style').each((_index, element) => {
    const node = $(element);
    if ((node.attr('w:type') ?? '').toLowerCase() !== 'paragraph') return;
    const styleId = node.attr('w:styleId');
    if (!styleId) return;
    const rawOutline = Number(node.children('w\\:pPr').find('w\\:outlineLvl').attr('w:val'));
    definitions.set(styleId, {
      basedOn: node.children('w\\:basedOn').attr('w:val') ?? null,
      outlineLevel:
        Number.isInteger(rawOutline) && rawOutline >= 0 && rawOutline <= 5 ? rawOutline : null,
    });
  });

  const mappings: string[] = [];
  for (const styleId of definitions.keys()) {
    const outlineLevel = resolveOutlineLevel(styleId, definitions, new Set());
    if (outlineLevel === null) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(styleId)) {
      warnings.add('DOCX_CUSTOM_STYLE_ID_UNMAPPED');
      continue;
    }
    mappings.push(`p.${styleId} => h${outlineLevel + 1}:fresh`);
  }
  return mappings;
}

/** 沿 basedOn 链继承 outlineLvl，并用 visited 防止损坏样式形成环。 */
function resolveOutlineLevel(
  styleId: string,
  definitions: ReadonlyMap<
    string,
    { readonly basedOn: string | null; readonly outlineLevel: number | null }
  >,
  visited: Set<string>,
): number | null {
  if (visited.has(styleId)) return null;
  visited.add(styleId);
  const definition = definitions.get(styleId);
  if (!definition) return null;
  if (definition.outlineLevel !== null) return definition.outlineLevel;
  return definition.basedOn ? resolveOutlineLevel(definition.basedOn, definitions, visited) : null;
}

/** 把尚未完整结构化的 Word 能力转成稳定质量告警。 */
function collectDocxBoundaryWarnings(
  entryNames: readonly string[],
  documentBytes: Uint8Array,
  warnings: Set<string>,
): void {
  if (entryNames.some((name) => /^word\/(header|footer)\d+\.xml$/i.test(name))) {
    warnings.add('DOCX_HEADER_FOOTER_NOT_EXTRACTED');
  }
  if (entryNames.some((name) => /^word\/(footnotes|endnotes)\.xml$/i.test(name))) {
    warnings.add('DOCX_FOOTNOTE_ENDNOTE_NOT_EXTRACTED');
  }
  const $ = load(new TextDecoder().decode(documentBytes), { xmlMode: true });
  if ($('w\\:txbxContent').length > 0) warnings.add('DOCX_TEXTBOX_SUPPORT_PARTIAL');
  if ($('w\\:ins,w\\:del,w\\:moveFrom,w\\:moveTo').length > 0) {
    warnings.add('DOCX_TRACKED_CHANGES_PRESENT');
  }
  if ($('w\\:altChunk').length > 0) warnings.add('DOCX_ALTCHUNK_NOT_EXTRACTED');
}

/** 图片相对正文是内联、浮动还是旧式 VML。 */
function readAnchorKind(
  node: ReturnType<ReturnType<typeof load>>,
): DocxImageOccurrence['anchorKind'] {
  if (node.parents('wp\\:inline').length > 0) return 'INLINE';
  if (node.parents('wp\\:anchor').length > 0) return 'FLOATING';
  if (node.parents('w\\:pict').length > 0) return 'VML';
  return 'UNKNOWN';
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
