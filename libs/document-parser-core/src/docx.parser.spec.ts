/**
 * DOCX 图片和结构事实回归：验证 drawing relationship、重复出现位置、正文锚点和能力边界。
 * Fixture 使用最小真实 OOXML 与公开合成图片，不包含企业数据。
 *
 * @requirement PAR-021
 */
import { ZipFile } from 'yazl';
import type { ParserResult } from '@rag/contracts';
import { createDocumentParserRegistry } from './index';

const registry = createDocumentParserRegistry(
  {
    maxArchiveDepth: 3,
    maxCompressionRatio: 100,
    maxPages: 100,
    maxTotalPixels: 10_000_000,
    maxTableCells: 100_000,
    maxExpandedTableCells: 200_000,
    maxTableRows: 10_000,
    maxTableColumns: 1_000,
    maxTableSpan: 1_000,
    maxOutputCharacters: 1_000_000,
    maxInputBytes: 10_000_000,
    maxArchiveEntries: 10_000,
    maxXmlEntryBytes: 5_000_000,
  },
  { revision: 'docx-facts-r1', protocolVersion: '2' },
);

describe('[PAR-021] DOCX drawing and anchor facts', () => {
  it('按正文 drawing relationship 关联资产，同一资产重复引用仍保留三个出现位置', async () => {
    const result = await parseDocx(await docxFixture());
    const images = result.blocks.filter((block) => block.type === 'IMAGE');

    expect(result.ocrCandidates.map((target) => target.assetRef?.archiveEntryPath)).toEqual([
      'word/media/zebra.png',
      'word/media/alpha.png',
      'word/media/zebra.png',
    ]);
    expect(result.ocrCandidates.map((target) => target.targetId)).toEqual([
      'docx-image-occurrence-1',
      'docx-image-occurrence-2',
      'docx-image-occurrence-3',
    ]);
    expect(images).toHaveLength(3);
    expect(images.map((block) => block.metadata.archiveEntryPath)).toEqual([
      'word/media/zebra.png',
      'word/media/alpha.png',
      'word/media/zebra.png',
    ]);
    expect(images.map((block) => block.metadata.paragraphIndex)).toEqual([2, 4, 6]);
  });

  it('图片 Block 位于前后正文之间，且不伪造物理 pageNo 或 bbox', async () => {
    const result = await parseDocx(await docxFixture());
    expect(result.blocks.map((block) => block.type)).toEqual([
      'PARAGRAPH',
      'IMAGE',
      'PARAGRAPH',
      'IMAGE',
      'PARAGRAPH',
      'IMAGE',
      'TITLE',
    ]);
    for (const block of result.blocks) {
      expect(block.pageNo).toBeNull();
      expect(block.bbox).toBeNull();
    }
  });

  it('带 outlineLvl 的企业自定义段落样式恢复为标题', async () => {
    const result = await parseDocx(await docxFixture());
    expect(result.blocks.at(-1)).toMatchObject({
      type: 'TITLE',
      text: '企业自定义章节',
      headingLevel: 1,
    });
  });

  it('DOCX 编号层级复用 HTML 阅读顺序，合并表格坐标仍保持完整', async () => {
    const result = await parseDocx(await docxFixture({ includeStructures: true }));
    const listBlocks = result.blocks.filter((block) => block.type === 'LIST');
    const table = result.blocks.find((block) => block.type === 'TABLE');

    expect(listBlocks.map((block) => block.metadata.listDepth)).toEqual([1, 2]);
    expect(listBlocks.map((block) => block.text)).toEqual(['一级条目', '二级条目']);
    expect(table?.table?.mergedCells).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }]);
  });

  it('页眉页脚、脚注、文本框、修订与未知图片尺寸都返回明确告警', async () => {
    const result = await parseDocx(await docxFixture({ includeBoundaries: true }));
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'DOCX_HEADER_FOOTER_NOT_EXTRACTED',
        'DOCX_FOOTNOTE_ENDNOTE_NOT_EXTRACTED',
        'DOCX_TEXTBOX_SUPPORT_PARTIAL',
        'DOCX_TRACKED_CHANGES_PRESENT',
        'DOCX_IMAGE_DIMENSIONS_UNREADABLE',
        'DOCX_IMAGE_FORMAT_UNSUPPORTED',
      ]),
    );
  });

  it('正文图片关系缺失时 fail closed，不能按 media 文件顺序猜测', async () => {
    const bytes = await docxFixture({ omitFirstRelationship: true });
    await expect(parseDocx(bytes)).rejects.toMatchObject({
      code: 'DOCX_IMAGE_RELATIONSHIP_MISSING',
    });
  });
});

/** 通过完整 Registry 解析，包含最终 Zod 契约校验。 */
async function parseDocx(bytes: Uint8Array): Promise<ParserResult> {
  return registry.parse(
    {
      bytes,
      fileName: 'facts.docx',
      format: 'DOCX',
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    new AbortController().signal,
  );
}

/** 可选边界部件用于验证“不支持但可见”，默认 Fixture 聚焦正文图片顺序。 */
async function docxFixture(
  options: {
    readonly includeBoundaries?: boolean;
    readonly includeStructures?: boolean;
    readonly omitFirstRelationship?: boolean;
  } = {},
): Promise<Uint8Array> {
  const relationships = [
    ...(options.omitFirstRelationship
      ? []
      : [
          '<Relationship Id="rIdZebra" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/zebra.png"/>',
        ]),
    '<Relationship Id="rIdAlpha" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/alpha.png"/>',
    ...(options.includeBoundaries
      ? [
          '<Relationship Id="rIdUnknown" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unknown.emf"/>',
        ]
      : []),
    ...(options.includeStructures
      ? [
          '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
        ]
      : []),
  ].join('');
  return zipEntries({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': documentXml(
      options.includeBoundaries === true,
      options.includeStructures === true,
    ),
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    'word/styles.xml':
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="CompanyChapter"><w:name w:val="企业章节"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    'word/media/alpha.png': tinyPng(),
    'word/media/zebra.png': tinyPng(),
    ...(options.includeStructures
      ? {
          'word/numbering.xml':
            '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
        }
      : {}),
    ...(options.includeBoundaries
      ? {
          'word/media/unknown.emf': 'not-an-image',
          'word/header1.xml':
            '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>',
          'word/footer1.xml':
            '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚</w:t></w:r></w:p></w:ftr>',
          'word/footnotes.xml':
            '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        }
      : {}),
  });
}

/** 正文把媒体文件名顺序、关系顺序与阅读顺序故意打乱。 */
function documentXml(includeBoundaries: boolean, includeStructures: boolean): string {
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>图片前正文</w:t></w:r></w:p>${drawingParagraph('rIdZebra', '第一张图')}<w:p><w:r><w:t>图片中间正文</w:t></w:r></w:p>${drawingParagraph('rIdAlpha', '第二张图')}<w:p><w:r><w:t>图片后正文</w:t></w:r></w:p>${drawingParagraph('rIdZebra', '重复第一张图')}<w:p><w:pPr><w:pStyle w:val="CompanyChapter"/></w:pPr><w:r><w:t>企业自定义章节</w:t></w:r></w:p>${includeStructures ? '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>一级条目</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>二级条目</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并表头</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' : ''}${includeBoundaries ? `<w:p><w:ins><w:r><w:t>修订插入</w:t></w:r></w:ins><w:del><w:r><w:delText>修订删除</w:delText></w:r></w:del><w:r><w:drawing><wp:inline><wp:docPr id="9" name="未知图"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdUnknown"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>` : ''}<w:sectPr/></w:body></w:document>`;
}

/** 最小合法 DrawingML 图片段落。 */
function drawingParagraph(relationshipId: string, alternative: string): string {
  return `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100000" cy="100000"/><wp:docPr id="1" name="${alternative}" descr="${alternative}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** yazl 创建真实 ZIP。 */
function zipEntries(entries: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(entries))
      zip.addBuffer(Buffer.from(content), name);
    zip.end();
  });
}

/** 1×1 透明 PNG。 */
function tinyPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}
