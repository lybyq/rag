/**
 * PPTX 内容事实回归：验证演示文稿关系页序、段落 Run、继承占位符、组合坐标和表格合并。
 * Fixture 只包含公开合成 XML，不依赖 Microsoft Office，也不包含企业数据。
 *
 * @requirement PAR-020
 */
import { ZipFile } from 'yazl';
import type { ParserResult } from '@rag/contracts';
import { createDocumentParserRegistry } from './index';

const limits = {
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
};

const registry = createDocumentParserRegistry(limits, {
  revision: 'pptx-facts-r1',
  protocolVersion: '2',
});

describe('[PAR-020] PPTX presentation facts', () => {
  it('按 presentation relationships 而不是 slide 文件名排序，并把同段 Run 直接拼接', async () => {
    const result = await parsePptx(await completePptxFixture());
    const title = result.blocks.find((block) => block.type === 'TITLE');

    expect(title).toMatchObject({
      slideNo: 1,
      text: '同一段落\n显式换行\n第二段',
      metadata: {
        archiveEntryPath: 'ppt/slides/slide10.xml',
        placeholderType: 'title',
      },
    });
    expect(result.blocks.find((block) => block.text === '编号较小但排在第二页')).toMatchObject({
      slideNo: 2,
      metadata: { archiveEntryPath: 'ppt/slides/slide2.xml' },
    });
    expect(result.pages.map((page) => page.pageNo)).toEqual([1, 2]);
    expect(result.ocrCandidates[0]).toMatchObject({
      slideNo: 1,
      assetRef: { archiveEntryPath: 'ppt/media/image1.png' },
    });
  });

  it('从 layout/master 继承标题类型，并把组合图形子坐标转换为幻灯片坐标', async () => {
    const result = await parsePptx(await completePptxFixture());
    const title = result.blocks.find((block) => block.type === 'TITLE');
    const groupedText = result.blocks.find((block) => block.text === '组合内文本');

    expect(title?.metadata.placeholderTypeSource).toBe('SLIDE_MASTER');
    expect(groupedText?.bbox).toEqual({ x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4 });
  });

  it('识别 a:tc 上的跨度与 hMerge/vMerge 延续格，矩阵和坐标始终完整', async () => {
    const result = await parsePptx(await completePptxFixture());
    const table = result.blocks.find((block) => block.type === 'TABLE');

    expect(table?.table).toEqual({
      rows: [
        ['主单元格', ''],
        ['', ''],
      ],
      headerRowCount: 1,
      mergedCells: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 2 }],
    });
    expect(
      result.pages.find((page) => page.pageNo === 2)?.textCharacterCount,
    ).toBeGreaterThanOrEqual('主单元格'.length);
  });

  it('隐藏页、备注、图表和 SmartArt 不静默丢失，统一返回可观测告警', async () => {
    const result = await parsePptx(await completePptxFixture());

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'PPTX_HIDDEN_SLIDE_INCLUDED',
        'PPTX_NOTES_NOT_EXTRACTED',
        'PPTX_CHART_NOT_EXTRACTED',
        'PPTX_SMARTART_NOT_EXTRACTED',
      ]),
    );
    expect(
      result.blocks.filter((block) => block.slideNo === 1).every((block) => block.metadata.hidden),
    ).toBe(true);
  });

  it('presentation 中引用不存在的 slide relationship 时 fail closed', async () => {
    const bytes = await zipEntries({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="missing"/></p:sldIdLst></p:presentation>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
    });

    await expect(parsePptx(bytes)).rejects.toMatchObject({
      code: 'PPTX_SLIDE_RELATIONSHIP_MISSING',
    });
  });
});

/** 调用真实 Registry，确保最终契约校验也参与测试。 */
async function parsePptx(bytes: Uint8Array): Promise<ParserResult> {
  return registry.parse(
    {
      bytes,
      fileName: 'facts.pptx',
      format: 'PPTX',
      declaredMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    new AbortController().signal,
  );
}

/** 构造页文件编号与真实页序故意相反的 PPTX，以覆盖删除/重排后的常见企业文档。 */
async function completePptxFixture(): Promise<Uint8Array> {
  return zipEntries({
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rIdSlide10" show="0"/><p:sldId id="257" r:id="rIdSlide2"/></p:sldIdLst><p:sldSz cx="10000000" cy="10000000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="rIdSlide10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide10.xml"/><Relationship Id="rIdSlide2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide10.xml': slideTenXml(),
    'ppt/slides/_rels/slide10.xml.rels':
      '<Relationships><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
    'ppt/slideLayouts/slideLayout1.xml':
      '<p:sldLayout xmlns:p="p"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels':
      '<Relationships><Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    'ppt/slideMasters/slideMaster1.xml':
      '<p:sldMaster xmlns:p="p"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sldMaster>',
    'ppt/slides/slide2.xml': slideTwoXml(),
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="p"><p:cSld/></p:notes>',
    'ppt/media/image1.png': tinyPng(),
  });
}

/** 第一张真实页覆盖 Run、显式换行、继承标题、隐藏页、图片与图表。 */
function slideTenXml(): string {
  return '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:c="c" show="0"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>同一</a:t></a:r><a:r><a:t>段落</a:t></a:r><a:br/><a:r><a:t>显式换行</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr name="截图"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill><p:spPr><a:xfrm><a:off x="6000000" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr></p:pic><p:graphicFrame><a:xfrm><a:off x="0" y="2000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>';
}

/** 第二张真实页覆盖组合坐标、二维合并表和 SmartArt 告警。 */
function slideTwoXml(): string {
  return '<p:sld xmlns:p="p" xmlns:a="a" xmlns:dgm="dgm"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>编号较小但排在第二页</a:t></a:r></a:p></p:txBody></p:sp><p:grpSp><p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="4000000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="2000000"/></a:xfrm></p:grpSpPr><p:sp><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>组合内文本</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:graphicFrame><a:xfrm><a:off x="0" y="6000000"/><a:ext cx="5000000" cy="2000000"/></a:xfrm><a:graphic><a:graphicData><a:tbl><a:tr><a:tc rowSpan="2" gridSpan="2"><a:txBody><a:p><a:r><a:t>主</a:t></a:r><a:r><a:t>单元格</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr><a:tr><a:tc vMerge="1"><a:txBody><a:p/></a:txBody></a:tc><a:tc hMerge="1" vMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>';
}

/** yazl 生成真实 ZIP；Parser 仍会执行重复条目、压缩比和大小检查。 */
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

/** 1×1 透明 PNG，用于图片关系与像素预算测试。 */
function tinyPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}
