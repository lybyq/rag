/**
 * HTML/Markdown/DOCX 共用的安全结构抽取器。
 *
 * 它按 DOM 子节点顺序分配“文本归属”，而不是用全局标签选择器抓文本：容器裸文本会被保留，
 * 已形成子 Block 的内容不会再被父容器重复吸收。活动内容先删除，外链只审计不请求。
 * 普通 HTML 文本完成实体解码并折叠排版空白，`br` 明确变成换行；`pre` 保留源码空白。
 * 本文件不负责 OCR、Chunk 或网络资源下载。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-011
 * @requirement PAR-017
 * @requirement PAR-018
 */
import { load, type CheerioAPI } from 'cheerio';
import type {
  DocumentBlockType,
  DocumentTable,
  OcrTarget,
  ParsedBlockCandidate,
} from '@rag/contracts';
import type { ParseResourceBudget } from './parse-resource-budget';
import { createBlock } from './types';

/** HTML 结构抽取结果供 HTML Parser、Markdown Parser 与 DOCX Parser 复用。 */
export interface HtmlStructureResult {
  readonly blocks: readonly ParsedBlockCandidate[];
  readonly ocrCandidates: readonly OcrTarget[];
  readonly externalLinkCount: number;
  readonly embeddedObjectCount: number;
  readonly tableCellCount: number;
  readonly warnings: readonly string[];
}

/** 只声明遍历需要的 DOM 字段，避免业务逻辑绑定 Cheerio 私有类。 */
interface HtmlNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly name?: string;
  readonly data?: string;
  readonly attribs?: Readonly<Record<string, string>>;
  readonly children?: readonly HtmlNode[];
}

/** 阅读上下文只携带可继承的引用、列表和嵌套表格语义。 */
interface TraversalContext {
  readonly quoteDepth: number;
  readonly listDepth: number;
  readonly nestedTableDepth: number;
}

/** 单次遍历的可变累加器，不暴露给格式 Parser。 */
interface ExtractionState {
  readonly blocks: ParsedBlockCandidate[];
  readonly ocrCandidates: OcrTarget[];
  readonly warnings: Set<string>;
  readonly budget: ParseResourceBudget;
  nextHtmlIndex: number;
}

/** 内联文本用私有哨兵区分真正的 `<br>` 与源代码排版换行。 */
const hardBreak = '\uE000';

/** 能与相邻文本共同归属一个 Block 的 HTML 行内元素。 */
const inlineTags = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'del',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

/** 一个行内片段要么是文本，要么是在同一阅读位置出现的图片。 */
type InlinePart =
  | { readonly kind: 'TEXT'; readonly value: string }
  | { readonly kind: 'IMAGE'; readonly node: HtmlNode };

/** 把已解码 HTML 映射为稳定文档顺序，所有远程链接只计数而不访问。 */
export function parseHtmlStructure(html: string, budget: ParseResourceBudget): HtmlStructureResult {
  budget.checkpoint();
  const $ = load(html);
  const embeddedObjectCount = $('object,embed,iframe').length;
  const externalLinkCount = countExternalLinks($);
  $('script,style,noscript,template,object,embed,iframe').remove();

  const state: ExtractionState = {
    blocks: [],
    ocrCandidates: [],
    warnings: new Set<string>(),
    budget,
    nextHtmlIndex: 0,
  };
  const rootNodes = $('body').contents().toArray() as unknown as HtmlNode[];
  visitNodes(rootNodes, { quoteDepth: 0, listDepth: 0, nestedTableDepth: 0 }, state);

  return {
    blocks: state.blocks,
    ocrCandidates: state.ocrCandidates,
    externalLinkCount,
    embeddedObjectCount,
    tableCellCount: budget.facts().actualTableCells,
    warnings: [
      ...(embeddedObjectCount > 0 ? ['HTML_ACTIVE_EMBED_REMOVED'] : []),
      ...state.warnings,
    ],
  };
}

/** 同级相邻裸文本/行内元素归入一个段落；遇块元素先 flush，避免父子重复。 */
function visitNodes(
  nodes: readonly HtmlNode[],
  context: TraversalContext,
  state: ExtractionState,
): void {
  let pending: InlinePart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    emitInlineParts(pending, 'PARAGRAPH', contextMetadata(context), state);
    pending = [];
  };

  for (const node of nodes) {
    state.budget.checkpoint();
    if (isText(node) || isInlineNode(node)) {
      collectInlineParts(node, pending);
      continue;
    }
    flush();
    if (isElement(node)) visitElement(node, context, state);
  }
  flush();
}

/** 按标签执行唯一结构策略；未知容器递归处理自己的直接子节点。 */
function visitElement(node: HtmlNode, context: TraversalContext, state: ExtractionState): void {
  const tag = tagName(node);
  if (/^h[1-6]$/.test(tag)) {
    const headingLevel = Number(tag.slice(1));
    emitInlineParts(
      childrenOf(node).flatMap(inlineParts),
      'TITLE',
      contextMetadata(context),
      state,
      headingLevel,
    );
    return;
  }
  if (tag === 'p') {
    emitInlineParts(
      childrenOf(node).flatMap(inlineParts),
      'PARAGRAPH',
      contextMetadata(context),
      state,
    );
    return;
  }
  if (tag === 'pre') {
    const originalText = collectPreformattedText(node);
    if (originalText.length > 0)
      emitTextBlock('CODE', originalText, contextMetadata(context), state);
    return;
  }
  if (tag === 'blockquote') {
    visitNodes(childrenOf(node), { ...context, quoteDepth: context.quoteDepth + 1 }, state);
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    visitList(node, context, state);
    return;
  }
  if (tag === 'li') {
    // 非法/片段 HTML 可能出现孤立 li；仍明确输出 LIST，而不是丢掉正文。
    visitListItem(node, context, state, null, 'UNORDERED');
    return;
  }
  if (tag === 'table') {
    visitTable(node, context, state);
    return;
  }
  if (tag === 'img') {
    emitImage(node, context, state);
    return;
  }
  if (tag === 'figcaption') {
    emitInlineParts(
      childrenOf(node).flatMap(inlineParts),
      'CAPTION',
      contextMetadata(context),
      state,
    );
    return;
  }
  if (tag === 'header' || tag === 'footer') {
    emitInlineParts(
      childrenOf(node).flatMap(inlineParts),
      tag === 'header' ? 'HEADER' : 'FOOTER',
      contextMetadata(context),
      state,
    );
    return;
  }
  if (tag === 'hr' || tag === 'meta' || tag === 'link') return;
  visitNodes(childrenOf(node), context, state);
}

/** 读取有序/无序列表的直接 li，编号变化遵循 start/value。 */
function visitList(node: HtmlNode, context: TraversalContext, state: ExtractionState): void {
  const ordered = tagName(node) === 'ol';
  let nextNumber = ordered ? positiveListNumber(node.attribs?.start, 1) : null;
  const listKind = ordered ? 'ORDERED' : 'UNORDERED';
  for (const item of childrenOf(node).filter((child) => tagName(child) === 'li')) {
    const itemNumber = ordered ? positiveListNumber(item.attribs?.value, nextNumber ?? 1) : null;
    visitListItem(item, context, state, itemNumber, listKind);
    if (ordered && itemNumber !== null) nextNumber = itemNumber + 1;
  }
}

/** li 的 own text 排除嵌套列表/表格，随后再按出现顺序处理这些子结构。 */
function visitListItem(
  item: HtmlNode,
  context: TraversalContext,
  state: ExtractionState,
  itemNumber: number | null,
  listKind: 'ORDERED' | 'UNORDERED',
): void {
  const listDepth = context.listDepth + 1;
  const metadata = {
    ...contextMetadata(context),
    listDepth,
    listKind,
    itemNumber,
    listMarker: listKind === 'ORDERED' ? `${itemNumber ?? 1}.` : '-',
  };
  const ownedParts: InlinePart[] = [];
  collectOwnedListParts(item, ownedParts, true);
  emitInlineParts(ownedParts, 'LIST', metadata, state);

  for (const child of ownedNestedStructures(item)) {
    const tag = tagName(child);
    if (tag === 'ul' || tag === 'ol') visitList(child, { ...context, listDepth }, state);
    else if (tag === 'table') visitTable(child, { ...context, listDepth }, state);
  }
}

/** 外表先输出，直接嵌套表随后独立输出；内表行永远不参与外表矩阵。 */
function visitTable(node: HtmlNode, context: TraversalContext, state: ExtractionState): void {
  const table = readHtmlTable(node, state.budget);
  if (table) {
    const originalText = table.rows.map((row) => row.join(' | ')).join('\n');
    emitTextBlock(
      'TABLE',
      originalText,
      { ...contextMetadata(context), nestedTableDepth: context.nestedTableDepth },
      state,
      { table },
    );
  }
  const nestedTables = directNestedTables(node);
  if (nestedTables.length > 0) state.warnings.add('HTML_NESTED_TABLE_SEPARATED');
  for (const nested of nestedTables) {
    visitTable(nested, { ...context, nestedTableDepth: context.nestedTableDepth + 1 }, state);
  }
}

/** 解析直接行/单元格；尾部 rowspan/colspan 占位全部落到实际矩阵。 */
function readHtmlTable(tableNode: HtmlNode, budget: ParseResourceBudget): DocumentTable | null {
  const sourceRows = directTableRows(tableNode);
  const rows: string[][] = [];
  const mergedCells: { row: number; column: number; rowSpan: number; columnSpan: number }[] = [];
  const occupied = new Set<string>();
  let headerRowCount = 0;
  let headerPhase = true;
  let maximumRequiredRows = 0;
  let maximumRequiredColumns = 0;
  let consumedExpandedCells = 0;

  for (const sourceRow of sourceRows) {
    budget.checkpoint();
    const cells = childrenOf(sourceRow).filter((child) => {
      const tag = tagName(child);
      return tag === 'th' || tag === 'td';
    });
    if (cells.length === 0) continue;
    const rowIndex = rows.length;
    const row: string[] = [];
    let column = 0;
    const isHeaderRow = cells.every((cell) => tagName(cell) === 'th');
    if (headerPhase && isHeaderRow) headerRowCount += 1;
    else headerPhase = false;

    for (const cell of cells) {
      budget.checkpoint();
      while (occupied.has(cellKey(rowIndex, column))) {
        budget.assertTableShape(rowIndex + 1, column + 1);
        row[column] = '';
        column += 1;
      }
      const rowSpan = positiveSpan(cell.attribs?.rowspan);
      const columnSpan = positiveSpan(cell.attribs?.colspan);
      const expandedCells = budget.assertTableSpan(rowSpan, columnSpan);
      budget.assertTableShape(rowIndex + rowSpan, column + columnSpan);
      budget.consumeTableCells(1, expandedCells);
      consumedExpandedCells += expandedCells;

      while (row.length < column) row.push('');
      row[column] = extractTableCellText(cell);
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
          if (rowOffset > 0 || columnOffset > 0) {
            occupied.add(cellKey(rowIndex + rowOffset, column + columnOffset));
          }
        }
      }
      if (rowSpan > 1 || columnSpan > 1) {
        mergedCells.push({ row: rowIndex, column, rowSpan, columnSpan });
      }
      maximumRequiredRows = Math.max(maximumRequiredRows, rowIndex + rowSpan);
      maximumRequiredColumns = Math.max(maximumRequiredColumns, column + columnSpan);
      column += columnSpan;
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;

  while (rows.length < maximumRequiredRows) {
    budget.checkpoint();
    rows.push([]);
  }
  const width = Math.max(maximumRequiredColumns, ...rows.map((row) => row.length));
  const rectangularCells = budget.tableArea(rows.length, width);
  budget.consumeTableCells(0, Math.max(0, rectangularCells - consumedExpandedCells));
  for (const row of rows) {
    budget.checkpoint();
    while (row.length < width) row.push('');
  }
  return { rows, headerRowCount, mergedCells };
}

/** 在一个容器内收集普通行内内容；图片保留为独立阅读事件。 */
function inlineParts(node: HtmlNode): InlinePart[] {
  const parts: InlinePart[] = [];
  collectInlineParts(node, parts);
  return parts;
}

/** 递归收集行内内容，br 使用硬换行哨兵，img 不读取网络资源。 */
function collectInlineParts(node: HtmlNode, parts: InlinePart[]): void {
  if (isText(node)) {
    parts.push({ kind: 'TEXT', value: node.data ?? '' });
    return;
  }
  const tag = tagName(node);
  if (tag === 'br') {
    parts.push({ kind: 'TEXT', value: hardBreak });
    return;
  }
  if (tag === 'wbr') return;
  if (tag === 'img') {
    parts.push({ kind: 'IMAGE', node });
    return;
  }
  for (const child of childrenOf(node)) collectInlineParts(child, parts);
}

/** li own-text 收集器在遇到嵌套列表或表格时停止下降。 */
function collectOwnedListParts(node: HtmlNode, parts: InlinePart[], isRoot = false): void {
  const tag = tagName(node);
  if (!isRoot && (tag === 'ul' || tag === 'ol' || tag === 'table')) return;
  if (isText(node) || tag === 'br' || tag === 'img' || tag === 'wbr') {
    collectInlineParts(node, parts);
    return;
  }
  const boundary = !isRoot && ['p', 'div', 'section', 'article', 'pre'].includes(tag);
  if (boundary) parts.push({ kind: 'TEXT', value: hardBreak });
  for (const child of childrenOf(node)) collectOwnedListParts(child, parts);
  if (boundary) parts.push({ kind: 'TEXT', value: hardBreak });
}

/** 找出当前 li 直接拥有的嵌套列表/表格，不进入已经命中的子结构。 */
function ownedNestedStructures(item: HtmlNode): HtmlNode[] {
  const found: HtmlNode[] = [];
  const walk = (node: HtmlNode): void => {
    for (const child of childrenOf(node)) {
      const tag = tagName(child);
      if (tag === 'ul' || tag === 'ol' || tag === 'table') found.push(child);
      else walk(child);
    }
  };
  walk(item);
  return found;
}

/** 输出文本和图片片段；图片前后的文本各自保持真实阅读顺序。 */
function emitInlineParts(
  parts: readonly InlinePart[],
  type: DocumentBlockType,
  metadata: Readonly<Record<string, unknown>>,
  state: ExtractionState,
  headingLevel: number | null = null,
): void {
  let textBuffer = '';
  const flushText = (): void => {
    const normalized = normalizeHtmlText(textBuffer);
    textBuffer = '';
    if (normalized.length === 0) return;
    emitTextBlock(type, normalized, metadata, state, { headingLevel });
  };
  for (const part of parts) {
    if (part.kind === 'TEXT') textBuffer += part.value;
    else {
      flushText();
      emitImage(part.node, emptyContext(), state, metadata);
    }
  }
  flushText();
}

/** 创建文本 Block，并统一附加单调 htmlIndex 与资源预算。 */
function emitTextBlock(
  type: DocumentBlockType,
  originalText: string,
  metadata: Readonly<Record<string, unknown>>,
  state: ExtractionState,
  overrides: Partial<Pick<ParsedBlockCandidate, 'headingLevel' | 'table'>> = {},
): void {
  state.budget.consumeOutputCharacters(originalText.length);
  const htmlIndex = state.nextHtmlIndex;
  state.nextHtmlIndex += 1;
  state.blocks.push(
    createBlock(type, originalText, {
      ...overrides,
      metadata: { extractionSource: 'NATIVE', htmlIndex, ...metadata },
    }),
  );
}

/** 图片只保留 alt/src 类型和阅读位置；绝不下载 src。 */
function emitImage(
  node: HtmlNode,
  context: TraversalContext,
  state: ExtractionState,
  inheritedMetadata: Readonly<Record<string, unknown>> = {},
): void {
  const alternative = normalizeHtmlText(node.attribs?.alt ?? '');
  const source = node.attribs?.src?.trim() ?? '';
  state.budget.consumeOutputCharacters(alternative.length);
  const htmlIndex = state.nextHtmlIndex;
  state.nextHtmlIndex += 1;
  state.blocks.push(
    createBlock('IMAGE', alternative, {
      metadata: {
        extractionSource: 'NATIVE',
        htmlIndex,
        ...contextMetadata(context),
        ...inheritedMetadata,
        sourceKind: classifyLink(source),
        // DOCX 会给 Mammoth 图片写入 about:blank# 内部标识；只保留 fragment，不保存外部 URL。
        ...(internalSourceReference(source)
          ? { sourceReference: internalSourceReference(source) }
          : {}),
      },
    }),
  );
  state.ocrCandidates.push({
    targetId: `html-image-${htmlIndex + 1}`,
    kind: 'EMBEDDED_IMAGE',
    pageNo: null,
    slideNo: null,
    sheetName: null,
    bbox: null,
    assetRef: null,
    reason: 'EMBEDDED_SCREENSHOT',
  });
}

/** 只允许 about:blank 的本地 fragment 穿过 HTML 层，用于上层关联文档内部资产。 */
function internalSourceReference(source: string): string | null {
  const prefix = 'about:blank#';
  return source.startsWith(prefix) && source.length > prefix.length
    ? source.slice(prefix.length)
    : null;
}

/** 普通 HTML 空白折叠；只有 br 哨兵成为换行，避免源码缩进制造伪换行。 */
function normalizeHtmlText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\t\n\f ]+/g, ' ')
    .replace(new RegExp(` *${hardBreak} *`, 'g'), '\n')
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** pre 文本不折叠空白，仅把 br 解释为换行并保留 Markdown 代码尾换行。 */
function collectPreformattedText(node: HtmlNode): string {
  let output = '';
  const walk = (current: HtmlNode): void => {
    if (isText(current)) {
      output += current.data ?? '';
      return;
    }
    if (tagName(current) === 'br') {
      output += '\n';
      return;
    }
    for (const child of childrenOf(current)) walk(child);
  };
  walk(node);
  return output.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/** 表格单元格读取普通后代文本，但遇到嵌套 table 就停止。 */
function extractTableCellText(cell: HtmlNode): string {
  let raw = '';
  const walk = (node: HtmlNode, isRoot = false): void => {
    if (!isRoot && tagName(node) === 'table') return;
    if (isText(node)) {
      raw += node.data ?? '';
      return;
    }
    if (tagName(node) === 'br') {
      raw += hardBreak;
      return;
    }
    const boundary =
      !isRoot && ['p', 'div', 'section', 'article', 'li', 'pre'].includes(tagName(node));
    if (boundary) raw += hardBreak;
    for (const child of childrenOf(node)) walk(child);
    if (boundary) raw += hardBreak;
  };
  walk(cell, true);
  return normalizeHtmlText(raw);
}

/** HTML parser 通常插入 tbody，因此同时读取 table 直系 tr 与分区直系 tr。 */
function directTableRows(table: HtmlNode): HtmlNode[] {
  const rows: HtmlNode[] = [];
  for (const child of childrenOf(table)) {
    const tag = tagName(child);
    if (tag === 'tr') rows.push(child);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      rows.push(...childrenOf(child).filter((candidate) => tagName(candidate) === 'tr'));
    }
  }
  return rows;
}

/** 返回当前外表直接包含的内表；不递归穿透已经命中的内表。 */
function directNestedTables(table: HtmlNode): HtmlNode[] {
  const nested: HtmlNode[] = [];
  const walk = (node: HtmlNode): void => {
    for (const child of childrenOf(node)) {
      if (tagName(child) === 'table') nested.push(child);
      else walk(child);
    }
  };
  walk(table);
  return nested;
}

/** 引用语义随子 Block 继承；零深度时不制造无意义字段。 */
function contextMetadata(context: TraversalContext): Readonly<Record<string, unknown>> {
  return context.quoteDepth > 0 ? { semantic: 'BLOCKQUOTE', quoteDepth: context.quoteDepth } : {};
}

/** 空阅读上下文用于继承元数据已经显式传入的行内图片。 */
function emptyContext(): TraversalContext {
  return { quoteDepth: 0, listDepth: 0, nestedTableDepth: 0 };
}

/** 合法大跨度交给统一预算；非法、零或负跨度按 HTML 默认值 1。 */
function positiveSpan(value: string | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** ol start 与 li value 只接受正安全整数，非法值回退当前编号。 */
function positiveListNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** DOM 文本节点判定。 */
function isText(node: HtmlNode): boolean {
  return node.type === 'text';
}

/** DOM 元素节点判定。 */
function isElement(node: HtmlNode): boolean {
  return tagName(node).length > 0;
}

/** 文本或白名单行内元素可以与相邻文本共享归属。 */
function isInlineNode(node: HtmlNode): boolean {
  return isElement(node) && inlineTags.has(tagName(node));
}

/** 兼容 htmlparser2 的 tagName/name 字段。 */
function tagName(node: HtmlNode): string {
  return (node.tagName ?? node.name ?? '').toLowerCase();
}

/** 无子节点时统一返回空数组。 */
function childrenOf(node: HtmlNode): readonly HtmlNode[] {
  return node.children ?? [];
}

/** occupied Set 的稳定键，不使用可能冲突的数字位运算。 */
function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

/** 只判断 URL 类型，不发起 DNS 或网络请求。 */
function classifyLink(value: string): 'EMPTY' | 'DATA' | 'LOCAL' | 'EXTERNAL' {
  if (!value) return 'EMPTY';
  if (value.startsWith('data:')) return 'DATA';
  if (/^(https?:)?\/\//i.test(value)) return 'EXTERNAL';
  return 'LOCAL';
}

/** 统计会离开当前文档的链接，javascript/data 不执行但仍纳入外链审计。 */
function countExternalLinks($: CheerioAPI): number {
  let count = 0;
  $('a[href],img[src],link[href],video[src],audio[src],source[src]').each((_index, element) => {
    const node = $(element);
    const value = (node.attr('href') ?? node.attr('src') ?? '').trim();
    if (classifyLink(value) === 'EXTERNAL' || /^javascript:/i.test(value)) count += 1;
  });
  return count;
}
