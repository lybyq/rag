/**
 * PPTX Parser：直接读取安全检查后的 OOXML 演示文稿、关系、版式、母版和媒体部件。
 * 它以 presentation.xml 的关系顺序为真相，恢复段落、标题、表格、图片和组合图形坐标。
 * 不渲染幻灯片、不执行宏，也不假装已经支持备注、图表或 SmartArt；未提取内容必须显式告警。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-017
 * @requirement PAR-020
 */
import { load, type CheerioAPI } from 'cheerio';
import { posix } from 'node:path';
import type {
  DocumentTable,
  NormalizedBoundingBox,
  OcrTarget,
  ParsedBlockCandidate,
} from '@rag/contracts';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, clamp01, createBlock } from './types';
import { readSafeOfficeArchive } from './safe-ooxml';
import { readImageDimensions } from './image-dimensions';
import type { ParseResourceBudget } from './parse-resource-budget';

/** presentation.xml 中一张幻灯片的真实顺序与可见性。 */
interface PresentationSlide {
  readonly entryPath: string;
  readonly hidden: boolean;
}

/** OOXML 关系经过相对路径归一化后的最小事实。 */
interface PartRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

/** 把当前坐标系的 EMU 坐标映射到幻灯片全局坐标。 */
interface CoordinateTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** 占位符类型同时记录来源，方便排查模板继承。 */
interface PlaceholderResolution {
  readonly type: string | null;
  readonly source: 'SLIDE' | 'SLIDE_LAYOUT' | 'SLIDE_MASTER' | null;
}

/** PowerPoint OOXML Parser。 */
export class PptxDocumentParser implements DocumentFormatParser {
  public readonly format = 'PPTX' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    const archive = await readSafeOfficeArchive(input.bytes, 'PPTX', limits, signal);
    const warnings = new Set<string>();
    const presentationBytes = archive.entries.get('ppt/presentation.xml');
    const slides = readPresentationSlides(archive.entries, presentationBytes, warnings);
    if (slides.length === 0) {
      throw new DocumentParserError('PPTX_SLIDES_MISSING', 'PPTX 不包含幻灯片');
    }
    if (slides.length > limits.maxPages) {
      throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'PPTX 幻灯片数量超过安全上限');
    }

    if (archive.entryNames.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name))) {
      warnings.add('PPTX_NOTES_NOT_EXTRACTED');
    }

    const slideSize = readSlideSize(presentationBytes);
    const blocks: ParsedBlockCandidate[] = [];
    const pages: FormatParseOutput['pages'][number][] = [];
    const ocrCandidates: OcrTarget[] = [];

    for (const [slideIndex, slide] of slides.entries()) {
      budget.checkpoint();
      const slideNo = slideIndex + 1;
      const bytes = archive.entries.get(slide.entryPath);
      if (!bytes) {
        throw new DocumentParserError('PPTX_SLIDE_XML_MISSING', 'PPTX 幻灯片 XML 缺失');
      }
      const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
      const hidden = slide.hidden || $('p\\:sld').first().attr('show') === '0';
      if (hidden) warnings.add('PPTX_HIDDEN_SLIDE_INCLUDED');

      const relationships = readPartRelationships(archive.entries, slide.entryPath);
      const relationshipById = new Map(
        relationships.map((relationship) => [relationship.id, relationship]),
      );
      const inheritedPlaceholders = readInheritedPlaceholders(archive.entries, relationships);
      let slideCharacters = 0;
      let pictureCount = 0;
      let shapeIndex = 0;

      const shapeTree = $('p\\:spTree').first();
      walkShapeTree($, shapeTree, identityTransform(), warnings, (node, transform) => {
        budget.checkpoint();
        const currentShapeIndex = shapeIndex;
        shapeIndex += 1;
        const tag = nodeTagName(node);
        const bbox = readShapeBox(node, tag, transform, slideSize, warnings);
        const baseMetadata = {
          extractionSource: 'NATIVE',
          shapeIndex: currentShapeIndex,
          archiveEntryPath: slide.entryPath,
          hidden,
        } as const;

        const graphicData = node.find('a\\:graphicData').first();
        const graphicUri = (graphicData.attr('uri') ?? '').toLowerCase();
        if (graphicUri.includes('/chart') || node.find('c\\:chart').length > 0) {
          warnings.add('PPTX_CHART_NOT_EXTRACTED');
          return;
        }
        if (
          graphicUri.includes('/diagram') ||
          node.find('dgm\\:relIds,dgm\\:dataModel,dsp\\:dataModelExt').length > 0
        ) {
          warnings.add('PPTX_SMARTART_NOT_EXTRACTED');
          return;
        }

        const tableNode = node.find('a\\:tbl').first();
        if (tableNode.length > 0) {
          const table = readPptTable($, tableNode, budget, warnings);
          if (!table) return;
          const tableText = table.rows.map((row) => row.join(' | ')).join('\n');
          budget.consumeOutputCharacters(tableText.length);
          slideCharacters += tableText.length;
          blocks.push(
            createBlock('TABLE', tableText, {
              pageNo: slideNo,
              slideNo,
              bbox,
              table,
              metadata: baseMetadata,
            }),
          );
          return;
        }

        if (tag === 'p:pic') {
          pictureCount += 1;
          const relationshipId = node.find('a\\:blip').attr('r:embed') ?? null;
          const relationship = relationshipId ? relationshipById.get(relationshipId) : undefined;
          const entryPath =
            relationship?.target.startsWith('ppt/media/') === true ? relationship.target : null;
          if (!entryPath) warnings.add('PPTX_IMAGE_ASSET_UNRESOLVED');
          const alternative =
            node.find('p\\:cNvPr').attr('descr') ?? node.find('p\\:cNvPr').attr('name') ?? '';
          budget.consumeOutputCharacters(alternative.length);
          slideCharacters += alternative.length;
          const targetId = `pptx-slide-${slideNo}-image-${pictureCount}`;
          blocks.push(
            createBlock('IMAGE', alternative, {
              pageNo: slideNo,
              slideNo,
              bbox,
              metadata: { ...baseMetadata, archiveEntryPath: entryPath, ocrTargetId: targetId },
            }),
          );
          ocrCandidates.push({
            targetId,
            kind: 'EMBEDDED_IMAGE',
            pageNo: slideNo,
            slideNo,
            sheetName: null,
            bbox,
            assetRef: entryPath
              ? {
                  storage: 'SOURCE_ARCHIVE_ENTRY',
                  archiveEntryPath: entryPath,
                  mediaType: mediaTypeFromName(entryPath),
                }
              : null,
            reason: 'EMBEDDED_SCREENSHOT',
          });
          return;
        }

        const textBody = node.children('p\\:txBody').first();
        const originalText = readTextBody($, textBody);
        if (originalText.trim().length === 0) return;
        budget.consumeOutputCharacters(originalText.length);
        slideCharacters += originalText.length;
        const placeholder = resolvePlaceholder(node, inheritedPlaceholders);
        const isTitle = placeholder.type === 'title' || placeholder.type === 'ctrtitle';
        blocks.push(
          createBlock(isTitle ? 'TITLE' : 'PARAGRAPH', originalText, {
            pageNo: slideNo,
            slideNo,
            bbox,
            headingLevel: isTitle ? 1 : null,
            metadata: {
              ...baseMetadata,
              placeholderType: placeholder.type,
              placeholderTypeSource: placeholder.source,
            },
          }),
        );
      });

      pages.push({
        pageNo: slideNo,
        textCharacterCount: slideCharacters,
        textCoverage: Math.min(1, slideCharacters / 2_000),
        imageOnly: slideCharacters === 0 && pictureCount > 0,
      });
    }

    const mediaEntries = archive.entryNames.filter((name) => name.startsWith('ppt/media/'));
    sumMediaPixels(mediaEntries, archive.entries, budget, warnings);
    if (ocrCandidates.length > 0) warnings.add('PPTX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY');
    const budgetFacts = budget.facts();
    return {
      blocks,
      pages,
      ocrCandidates,
      inspection: {
        encrypted: archive.encrypted,
        hasMacros: archive.hasMacros,
        embeddedObjectCount: archive.embeddedObjectCount,
        externalLinkCount: archive.externalLinkCount,
        archiveDepth: archive.archiveDepth,
        compressedSizeBytes: archive.compressedSizeBytes,
        uncompressedSizeBytes: archive.uncompressedSizeBytes,
        pageCount: slides.length,
        totalPixels: budgetFacts.totalPixels,
        tableCellCount: budgetFacts.actualTableCells,
      },
      warnings: [...warnings],
    };
  }
}

/**
 * 读取真实页序。只要 presentation 声明了 sldIdLst，就不能退回文件名猜测；关系缺失按损坏文档拒绝。
 */
function readPresentationSlides(
  entries: ReadonlyMap<string, Uint8Array>,
  presentationBytes: Uint8Array | undefined,
  warnings: Set<string>,
): readonly PresentationSlide[] {
  if (!presentationBytes) {
    throw new DocumentParserError('PPTX_PRESENTATION_XML_MISSING', 'PPTX presentation.xml 缺失');
  }
  const $ = load(new TextDecoder().decode(presentationBytes), { xmlMode: true });
  const slideIds = $('p\\:sldIdLst').first().children('p\\:sldId').toArray();
  if (slideIds.length === 0) {
    warnings.add('PPTX_PRESENTATION_ORDER_FALLBACK');
    return [...entries.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((left, right) => slideFileNumber(left) - slideFileNumber(right))
      .map((entryPath) => ({ entryPath, hidden: false }));
  }

  const byId = new Map(
    readPartRelationships(entries, 'ppt/presentation.xml').map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const seen = new Set<string>();
  return slideIds.map((element) => {
    const node = $(element);
    const relationshipId = node.attr('r:id');
    const relationship = relationshipId ? byId.get(relationshipId) : undefined;
    if (
      !relationship ||
      !/^ppt\/slides\/slide\d+\.xml$/i.test(relationship.target) ||
      !entries.has(relationship.target) ||
      seen.has(relationship.target)
    ) {
      throw new DocumentParserError(
        'PPTX_SLIDE_RELATIONSHIP_MISSING',
        'PPTX 页序关系缺失、重复或未指向有效幻灯片',
      );
    }
    seen.add(relationship.target);
    return { entryPath: relationship.target, hidden: node.attr('show') === '0' };
  });
}

/** 从 presentation.xml 读取 EMU 画布尺寸；缺失尺寸时使用标准 16:9 尺寸。 */
function readSlideSize(bytes: Uint8Array | undefined): { width: number; height: number } {
  if (!bytes) return { width: 12_192_000, height: 6_858_000 };
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const node = $('p\\:sldSz').first();
  const width = Number(node.attr('cx'));
  const height = Number(node.attr('cy'));
  return width > 0 && height > 0 ? { width, height } : { width: 12_192_000, height: 6_858_000 };
}

/** 深度优先遍历 shape tree；组合图形只改变子坐标系，本身不产生正文 Block。 */
function walkShapeTree(
  $: CheerioAPI,
  parent: ReturnType<CheerioAPI>,
  transform: CoordinateTransform,
  warnings: Set<string>,
  visit: (node: ReturnType<CheerioAPI>, transform: CoordinateTransform) => void,
): void {
  for (const element of parent.children().toArray()) {
    const node = $(element);
    const tag = nodeTagName(node);
    if (tag === 'p:grpsp') {
      const groupTransform = readGroupTransform(node, transform, warnings);
      walkShapeTree($, node, groupTransform, warnings, visit);
      continue;
    }
    if (tag === 'p:sp' || tag === 'p:graphicframe' || tag === 'p:pic' || tag === 'p:cxnsp') {
      visit(node, transform);
    }
  }
}

/** 组合图形的 chOff/chExt 是内部坐标系，off/ext 是父坐标系中的落点和尺寸。 */
function readGroupTransform(
  node: ReturnType<CheerioAPI>,
  parent: CoordinateTransform,
  warnings: Set<string>,
): CoordinateTransform {
  const xfrm = node.children('p\\:grpSpPr').first().children('a\\:xfrm').first();
  const off = xfrm.children('a\\:off').first();
  const ext = xfrm.children('a\\:ext').first();
  const childOff = xfrm.children('a\\:chOff').first();
  const childExt = xfrm.children('a\\:chExt').first();
  const values = {
    x: finiteNumber(off.attr('x'), 0),
    y: finiteNumber(off.attr('y'), 0),
    width: finiteNumber(ext.attr('cx'), 0),
    height: finiteNumber(ext.attr('cy'), 0),
    childX: finiteNumber(childOff.attr('x'), 0),
    childY: finiteNumber(childOff.attr('y'), 0),
    childWidth: finiteNumber(childExt.attr('cx'), 0),
    childHeight: finiteNumber(childExt.attr('cy'), 0),
  };
  if (values.childWidth <= 0 || values.childHeight <= 0) {
    warnings.add('PPTX_GROUP_COORDINATE_INCOMPLETE');
    return parent;
  }
  if (hasRotationOrFlip(xfrm)) warnings.add('PPTX_ROTATED_COORDINATE_APPROXIMATED');
  const localScaleX = values.width / values.childWidth;
  const localScaleY = values.height / values.childHeight;
  return {
    scaleX: parent.scaleX * localScaleX,
    scaleY: parent.scaleY * localScaleY,
    offsetX: parent.offsetX + parent.scaleX * (values.x - values.childX * localScaleX),
    offsetY: parent.offsetY + parent.scaleY * (values.y - values.childY * localScaleY),
  };
}

/** 读取当前 shape 的局部坐标，应用所有父组合变换后归一化到 0～1。 */
function readShapeBox(
  node: ReturnType<CheerioAPI>,
  tag: string,
  transform: CoordinateTransform,
  slideSize: { width: number; height: number },
  warnings: Set<string>,
): NormalizedBoundingBox | null {
  const xfrm =
    tag === 'p:graphicframe'
      ? node.children('a\\:xfrm').first()
      : node.children('p\\:spPr').first().children('a\\:xfrm').first();
  const offset = xfrm.children('a\\:off').first();
  const extent = xfrm.children('a\\:ext').first();
  const x = Number(offset.attr('x'));
  const y = Number(offset.attr('y'));
  const width = Number(extent.attr('cx'));
  const height = Number(extent.attr('cy'));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (hasRotationOrFlip(xfrm)) warnings.add('PPTX_ROTATED_COORDINATE_APPROXIMATED');
  const globalX = transform.offsetX + x * transform.scaleX;
  const globalY = transform.offsetY + y * transform.scaleY;
  const globalWidth = width * transform.scaleX;
  const globalHeight = height * transform.scaleY;
  return {
    x1: clamp01(globalX / slideSize.width),
    y1: clamp01(globalY / slideSize.height),
    x2: clamp01((globalX + globalWidth) / slideSize.width),
    y2: clamp01((globalY + globalHeight) / slideSize.height),
  };
}

/** 只在段落之间和显式 a:br 处换行；同一段内多个 Run 必须直接连接。 */
function readTextBody($: CheerioAPI, textBody: ReturnType<CheerioAPI>): string {
  if (textBody.length === 0) return '';
  return textBody
    .children('a\\:p')
    .toArray()
    .map((paragraph) => readParagraphText($, $(paragraph)))
    .join('\n');
}

/** 按 DrawingML 子节点顺序读取一个段落，保留显式换行。 */
function readParagraphText($: CheerioAPI, paragraph: ReturnType<CheerioAPI>): string {
  const parts: string[] = [];
  for (const element of paragraph.children().toArray()) {
    const node = $(element);
    const tag = nodeTagName(node);
    if (tag === 'a:br') {
      parts.push('\n');
      continue;
    }
    if (tag === 'a:r' || tag === 'a:fld' || tag === 'a:t') {
      const texts =
        tag === 'a:t'
          ? [node.text()]
          : node
              .find('a\\:t')
              .toArray()
              .map((item) => $(item).text());
      parts.push(texts.join(''));
    }
  }
  return parts.join('');
}

/** 解析 a:tc 自身的跨度与 continuation 标志，并输出完整矩形。 */
function readPptTable(
  $: CheerioAPI,
  tableNode: ReturnType<CheerioAPI>,
  budget: ParseResourceBudget,
  warnings: Set<string>,
): DocumentTable | null {
  const sourceRows: {
    readonly text: string;
    readonly rowSpan: number;
    readonly columnSpan: number;
    readonly continuation: boolean;
  }[][] = [];
  const mergedCells: DocumentTable['mergedCells'] = [];
  let actualCells = 0;
  let outputRowCount = 0;
  let outputColumnCount = 0;

  for (const [rowIndex, rowElement] of tableNode.find('a\\:tr').toArray().entries()) {
    budget.assertTableShape(rowIndex + 1, 0);
    const cells = $(rowElement).children('a\\:tc').toArray();
    const sourceRow = [] as (typeof sourceRows)[number];
    for (const [columnIndex, cellElement] of cells.entries()) {
      budget.assertTableShape(rowIndex + 1, columnIndex + 1);
      const cell = $(cellElement);
      const properties = cell.children('a\\:tcPr').first();
      const rowSpan = positiveInteger(cell.attr('rowSpan') ?? properties.attr('rowSpan'));
      const columnSpan = positiveInteger(cell.attr('gridSpan') ?? properties.attr('gridSpan'));
      budget.assertTableSpan(rowSpan, columnSpan);
      const continuation =
        truthyOoxmlFlag(cell.attr('hMerge')) || truthyOoxmlFlag(cell.attr('vMerge'));
      const text = continuation ? '' : readTextBody($, cell.children('a\\:txBody').first());
      sourceRow.push({ text, rowSpan, columnSpan, continuation });
      actualCells += 1;
      outputRowCount = Math.max(outputRowCount, rowIndex + rowSpan);
      outputColumnCount = Math.max(outputColumnCount, columnIndex + columnSpan);
      if (!continuation && (rowSpan > 1 || columnSpan > 1)) {
        mergedCells.push({ row: rowIndex, column: columnIndex, rowSpan, columnSpan });
      }
    }
    sourceRows.push(sourceRow);
  }
  if (sourceRows.length === 0) return null;

  budget.assertTableShape(outputRowCount, outputColumnCount);
  const expandedCells = budget.tableArea(outputRowCount, outputColumnCount);
  budget.consumeTableCells(actualCells, expandedCells);
  const rows = Array.from({ length: outputRowCount }, () => Array(outputColumnCount).fill(''));
  sourceRows.forEach((sourceRow, rowIndex) => {
    sourceRow.forEach((cell, columnIndex) => {
      rows[rowIndex]![columnIndex] = cell.text;
    });
  });

  for (const [rowIndex, sourceRow] of sourceRows.entries()) {
    for (const [columnIndex, cell] of sourceRow.entries()) {
      if (!cell.continuation) continue;
      const covered = mergedCells.some(
        (merged) =>
          rowIndex >= merged.row &&
          rowIndex < merged.row + merged.rowSpan &&
          columnIndex >= merged.column &&
          columnIndex < merged.column + merged.columnSpan &&
          (rowIndex !== merged.row || columnIndex !== merged.column),
      );
      if (!covered) warnings.add('PPTX_TABLE_ORPHAN_MERGE_CONTINUATION');
    }
  }
  return { rows, headerRowCount: 1, mergedCells: [...mergedCells] };
}

/** 读取 slide -> layout -> master 的占位符类型继承链。 */
function readInheritedPlaceholders(
  entries: ReadonlyMap<string, Uint8Array>,
  slideRelationships: readonly PartRelationship[],
): ReadonlyMap<string, PlaceholderResolution> {
  const result = new Map<string, PlaceholderResolution>();
  const layoutRelationship = slideRelationships.find(
    (relationship) =>
      relationship.type.toLowerCase().endsWith('/slidelayout') ||
      relationship.target.startsWith('ppt/slideLayouts/'),
  );
  if (!layoutRelationship) return result;

  const layoutBytes = entries.get(layoutRelationship.target);
  if (!layoutBytes) return result;
  const layoutPlaceholders = readPlaceholderTypes(layoutBytes);
  for (const [index, type] of layoutPlaceholders) {
    if (type) result.set(index, { type, source: 'SLIDE_LAYOUT' });
  }

  const masterRelationship = readPartRelationships(entries, layoutRelationship.target).find(
    (relationship) =>
      relationship.type.toLowerCase().endsWith('/slidemaster') ||
      relationship.target.startsWith('ppt/slideMasters/'),
  );
  const masterBytes = masterRelationship ? entries.get(masterRelationship.target) : undefined;
  if (masterBytes) {
    for (const [index, type] of readPlaceholderTypes(masterBytes)) {
      if (type && !result.has(index)) result.set(index, { type, source: 'SLIDE_MASTER' });
    }
  }
  return result;
}

/** 解析一个 layout/master 中 idx -> type；idx 缺省按 OOXML 的 0 处理。 */
function readPlaceholderTypes(bytes: Uint8Array): ReadonlyMap<string, string | null> {
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const result = new Map<string, string | null>();
  $('p\\:ph').each((_index, element) => {
    const node = $(element);
    const index = node.attr('idx') ?? '0';
    const type = node.attr('type')?.toLowerCase() ?? null;
    if (!result.has(index) || type) result.set(index, type);
  });
  return result;
}

/** 直接类型优先；slide 缺 type 时才按 idx 查询 layout/master。 */
function resolvePlaceholder(
  shape: ReturnType<CheerioAPI>,
  inherited: ReadonlyMap<string, PlaceholderResolution>,
): PlaceholderResolution {
  const placeholder = shape.find('p\\:nvPr').first().children('p\\:ph').first();
  if (placeholder.length === 0) return { type: null, source: null };
  const directType = placeholder.attr('type')?.toLowerCase();
  if (directType) return { type: directType, source: 'SLIDE' };
  return inherited.get(placeholder.attr('idx') ?? '0') ?? { type: null, source: null };
}

/** 读取任一 OOXML Part 的关系，并相对该 Part 目录安全归一化 Target。 */
function readPartRelationships(
  entries: ReadonlyMap<string, Uint8Array>,
  partName: string,
): readonly PartRelationship[] {
  const relationshipName = `${posix.dirname(partName)}/_rels/${posix.basename(partName)}.rels`;
  const bytes = entries.get(relationshipName);
  if (!bytes) return [];
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const relationships: PartRelationship[] = [];
  $('Relationship').each((_index, element) => {
    const node = $(element);
    if (node.attr('TargetMode')?.toLowerCase() === 'external') return;
    const id = node.attr('Id');
    const target = node.attr('Target');
    if (!id || !target) return;
    const normalized = posix.normalize(posix.join(posix.dirname(partName), target));
    if (normalized.startsWith('../') || posix.isAbsolute(normalized)) return;
    relationships.push({ id, type: node.attr('Type') ?? '', target: normalized });
  });
  return relationships;
}

/** 从 slideN.xml 文件名取得编号，仅供旧文档缺少页序清单时确定性回退。 */
function slideFileNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

/** 合并字段只接受正整数；非法值按 OOXML 默认跨度 1 处理。 */
function positiveInteger(value: string | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** OOXML 布尔属性接受 1/true/on；其余值不视为启用。 */
function truthyOoxmlFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'on';
}

/** 无值或非有限数回退到调用方提供的安全默认值。 */
function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Cheerio 的 XML 标签名统一为小写，避免关系和 shape 路由受大小写影响。 */
function nodeTagName(node: ReturnType<CheerioAPI>): string {
  return String(node.prop('tagName') ?? '').toLowerCase();
}

/** 旋转和翻转会令轴对齐 bbox 成为近似值，因此必须向调用方暴露。 */
function hasRotationOrFlip(node: ReturnType<CheerioAPI>): boolean {
  return (
    Number(node.attr('rot') ?? 0) !== 0 ||
    truthyOoxmlFlag(node.attr('flipH')) ||
    truthyOoxmlFlag(node.attr('flipV'))
  );
}

/** 根坐标系不缩放、不平移。 */
function identityTransform(): CoordinateTransform {
  return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
}

/** 内嵌媒体像素累计；损坏图片保留 OCR 候选，同时明确记录尺寸告警。 */
function sumMediaPixels(
  names: readonly string[],
  entries: ReadonlyMap<string, Uint8Array>,
  budget: ParseResourceBudget,
  warnings: Set<string>,
): void {
  for (const name of names) {
    budget.checkpoint();
    const bytes = entries.get(name);
    if (!bytes) continue;
    try {
      const dimensions = readImageDimensions(bytes);
      if (dimensions.width && dimensions.height) {
        budget.consumePixels(dimensions.width, dimensions.height);
      } else {
        warnings.add('PPTX_MEDIA_DIMENSIONS_UNREADABLE');
      }
    } catch {
      warnings.add('PPTX_MEDIA_DIMENSIONS_UNREADABLE');
    }
  }
}

/** 媒体后缀到 MIME 的有限映射。 */
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
