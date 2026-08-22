/**
 * M03 Node Parser 的真实格式 Golden 与安全回归测试。
 * Fixture 全部由测试代码生成，不包含公司文档；断言固定 Block、定位、表格和 OCR 候选语义。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-011
 * @requirement PAR-014
 */
import ExcelJS from 'exceljs';
import { ZipFile } from 'yazl';
import { createDocumentParserRegistry } from './index';
import { readImageDimensions } from './image-dimensions';
import { readSafeOfficeArchive } from './safe-ooxml';

const limits = {
  maxArchiveDepth: 3,
  maxCompressionRatio: 100,
  maxPages: 100,
  maxTotalPixels: 10_000_000,
  maxTableCells: 100_000,
  maxInputBytes: 10 * 1024 * 1024,
  maxArchiveEntries: 1_000,
  maxXmlEntryBytes: 2 * 1024 * 1024,
};

const registry = createDocumentParserRegistry(limits, {
  revision: 'golden-r1',
  protocolVersion: '2',
});
const signal = new AbortController().signal;

describe('[PAR-006][PAR-014] Node multi-format parser golden', () => {
  it.each([
    ['PNG', tinyPng(), { width: 1, height: 1, type: 'png' }],
    ['JPEG', jpegHeader(3, 4), { width: 3, height: 4, type: 'jpg' }],
    ['GIF', gifHeader(3, 4), { width: 3, height: 4, type: 'gif' }],
    ['TIFF', tiffHeader(3, 4), { width: 3, height: 4, type: 'tiff' }],
    ['BMP', bmpHeader(3, 4), { width: 3, height: 4, type: 'bmp' }],
    ['WebP', webpHeader(3, 4), { width: 3, height: 4, type: 'webp' }],
  ])('[PAR-003] %s 尺寸由自有有界头解析器读取', (_name, bytes, expected) => {
    expect(readImageDimensions(bytes as Uint8Array)).toEqual(expected);
  });

  it.each([
    {
      format: 'TEXT' as const,
      fileName: 'sample.txt',
      declaredMime: 'text/plain',
      bytes: Buffer.from('第一段\n\n第二段', 'utf8'),
      expectedTypes: ['PARAGRAPH', 'PARAGRAPH'],
    },
    {
      format: 'CSV' as const,
      fileName: 'sample.csv',
      declaredMime: 'text/csv',
      bytes: Buffer.from('姓名,部门\n张三,研发\n李四,"销售,华东"', 'utf8'),
      expectedTypes: ['TABLE'],
    },
    {
      format: 'HTML' as const,
      fileName: 'sample.html',
      declaredMime: 'text/html',
      bytes: Buffer.from(
        '<h1>制度</h1><p>正文</p><table><tr><th colspan="2">表头</th></tr><tr><td>A</td><td>B</td></tr></table>',
        'utf8',
      ),
      expectedTypes: ['TITLE', 'PARAGRAPH', 'TABLE'],
    },
    {
      format: 'MARKDOWN' as const,
      fileName: 'sample.md',
      declaredMime: 'text/markdown',
      bytes: Buffer.from('# 标题\n\n- 列表\n\n```ts\nconst ok = true\n```', 'utf8'),
      expectedTypes: ['TITLE', 'LIST', 'CODE'],
    },
    {
      format: 'IMAGE' as const,
      fileName: 'sample.png',
      declaredMime: 'image/png',
      bytes: tinyPng(),
      expectedTypes: ['IMAGE'],
    },
  ])('$format 输出稳定统一 Block', async (fixture) => {
    const parsed = await registry.parse(fixture, signal);
    expect(parsed.blocks.map((block) => block.type)).toEqual(fixture.expectedTypes);
    expect({
      format: fixture.format,
      blocks: parsed.blocks.map((block) => ({
        type: block.type,
        text: block.text,
        headingLevel: block.headingLevel,
        table: block.table,
      })),
      pages: parsed.pages,
      targets: parsed.ocrCandidates.map((target) => ({
        id: target.targetId,
        kind: target.kind,
        reason: target.reason,
      })),
      inspection: parsed.inspection,
    }).toMatchSnapshot();
  });

  it('[PAR-011][PAR-014] DOCX 保留标题、表格合并与内嵌图片目标', async () => {
    const bytes = await docxFixture();
    const parsed = await registry.parse(
      {
        bytes,
        fileName: 'sample.docx',
        format: 'DOCX',
        declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      signal,
    );
    expect(parsed.blocks.map((block) => block.type)).toEqual(
      expect.arrayContaining(['TITLE', 'PARAGRAPH', 'TABLE', 'IMAGE']),
    );
    expect(parsed.blocks.find((block) => block.type === 'TABLE')?.table?.mergedCells).toEqual([
      expect.objectContaining({ columnSpan: 2 }),
    ]);
    expect(parsed.ocrCandidates).toEqual([
      expect.objectContaining({
        kind: 'EMBEDDED_IMAGE',
        assetRef: expect.objectContaining({ archiveEntryPath: 'word/media/image1.png' }),
      }),
    ]);
  });

  it('[PAR-011][PAR-014] XLSX 保留 Sheet、公式结果和合并单元格', async () => {
    const bytes = await xlsxFixture();
    const parsed = await registry.parse(
      {
        bytes,
        fileName: 'sample.xlsx',
        format: 'XLSX',
        declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      signal,
    );
    const table = parsed.blocks.find((block) => block.type === 'TABLE');
    expect(parsed.blocks[0]).toMatchObject({ type: 'TITLE', text: '预算', sheetName: '预算' });
    expect(table?.table?.rows).toEqual([
      ['部门', ''],
      ['研发', '3'],
    ]);
    expect(table?.table?.mergedCells).toEqual([expect.objectContaining({ columnSpan: 2 })]);
    expect(table?.metadata.formulas).toEqual([
      expect.objectContaining({ cell: 'B2', formula: '1+2', result: '3' }),
    ]);
  });

  it('[PAR-007][PAR-011][PAR-014] PPTX 保留 slideNo、bbox、表格和图片 OCR 目标', async () => {
    const bytes = await pptxFixture();
    const parsed = await registry.parse(
      {
        bytes,
        fileName: 'sample.pptx',
        format: 'PPTX',
        declaredMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
      signal,
    );
    expect(parsed.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'TITLE', slideNo: 1, text: '季度复盘' }),
        expect.objectContaining({ type: 'TABLE', slideNo: 1 }),
        expect.objectContaining({ type: 'IMAGE', slideNo: 1 }),
      ]),
    );
    expect(parsed.ocrCandidates[0]).toMatchObject({ kind: 'EMBEDDED_IMAGE', slideNo: 1 });
  });

  it('[PAR-007][PAR-014] 数字 PDF 输出 bbox 且不把有文字页面认定为纯图片', async () => {
    const parsed = await registry.parse(
      {
        bytes: simplePdf('Hello RAG'),
        fileName: 'sample.pdf',
        format: 'PDF',
        declaredMime: 'application/pdf',
      },
      signal,
    );
    expect(parsed.blocks[0]).toMatchObject({ type: 'PARAGRAPH', pageNo: 1 });
    expect(parsed.blocks[0]?.bbox).not.toBeNull();
    expect(parsed.pages).toEqual([expect.objectContaining({ pageNo: 1, imageOnly: false })]);
  });
});

describe('[PAR-003] OOXML security facts', () => {
  it('内部格式与声明格式不一致时 fail closed', async () => {
    const fakeXlsx = await zipEntries({ 'xl/workbook.xml': '<workbook />' });
    await expect(readSafeOfficeArchive(fakeXlsx, 'DOCX', limits, signal)).rejects.toMatchObject({
      code: 'OOXML_INTERNAL_FORMAT_MISMATCH',
    });
  });

  it('宏、嵌入对象与外链都会形成结构事实', async () => {
    const bytes = await zipEntries({
      'word/document.xml': '<w:document xmlns:w="w"><w:body /></w:document>',
      'word/vbaProject.bin': 'macro',
      'word/embeddings/oleObject1.bin': 'ole',
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="https://example.invalid" TargetMode="External" /></Relationships>',
    });
    const archive = await readSafeOfficeArchive(bytes, 'DOCX', limits, signal);
    expect(archive).toMatchObject({
      hasMacros: true,
      embeddedObjectCount: 1,
      externalLinkCount: 1,
    });
  });

  it('高解压比条目在解压前被拒绝', async () => {
    const bomb = await zipEntries({
      'word/document.xml': `<w:document>${'A'.repeat(20_000)}</w:document>`,
    });
    await expect(
      readSafeOfficeArchive(bomb, 'DOCX', { ...limits, maxCompressionRatio: 2 }, signal),
    ).rejects.toMatchObject({ code: 'COMPRESSION_RATIO_EXCEEDED' });
  });

  it('加密标志在第三方内容库打开条目前被明确拒绝', async () => {
    const encrypted = markFirstZipEntryEncrypted(
      await zipEntries({ 'word/document.xml': '<w:document />' }),
    );
    await expect(readSafeOfficeArchive(encrypted, 'DOCX', limits, signal)).rejects.toMatchObject({
      code: 'OOXML_ENCRYPTED_UNSUPPORTED',
    });
  });

  it('重复 ZIP 条目被拒绝，避免安全检查与内容库读取不同副本', async () => {
    const duplicate = await zipEntryPairs([
      ['word/document.xml', '<w:document><w:body /></w:document>'],
      ['word/document.xml', '<w:document><w:evil /></w:document>'],
    ]);
    await expect(readSafeOfficeArchive(duplicate, 'DOCX', limits, signal)).rejects.toMatchObject({
      code: 'OOXML_DUPLICATE_ENTRY',
    });
  });

  it('XLSX 恶意远端单元格坐标在物化空列前被上限拦截', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('稀疏攻击');
    sheet.getCell('ZZ1').value = '远端单元格';
    const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBufferLike);
    const constrainedRegistry = createDocumentParserRegistry(
      { ...limits, maxTableCells: 10 },
      { revision: 'security-r1', protocolVersion: '2' },
    );
    await expect(
      constrainedRegistry.parse(
        {
          bytes,
          fileName: 'sparse.xlsx',
          format: 'XLSX',
          declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'TABLE_CELL_LIMIT_EXCEEDED' });
  });
});

/** 生成只包含公开合成内容的 DOCX。 */
async function docxFixture(): Promise<Uint8Array> {
  return zipEntries({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>制度标题</w:t></w:r></w:p><w:p><w:r><w:t>制度正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并表头</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing /></w:r></w:p></w:body></w:document>',
    'word/media/image1.png': tinyPng(),
  });
}

/** 使用 ExcelJS 生成带合并表头和公式缓存值的真实 XLSX。 */
async function xlsxFixture(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('预算');
  sheet.addRow(['部门', '金额']);
  sheet.mergeCells('A1:B1');
  sheet.addRow(['研发', { formula: '1+2', result: 3 }]);
  const bytes = await workbook.xlsx.writeBuffer();
  return new Uint8Array(bytes as ArrayBufferLike);
}

/** 生成足够表达文本框、表格、图片关系和画布尺寸的 PPTX。 */
async function pptxFixture(): Promise<Uint8Array> {
  return zipEntries({
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    'ppt/slides/slide1.xml':
      '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>季度复盘</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:xfrm><a:off x="0" y="1000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:pic><p:nvPicPr><p:cNvPr name="截图"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr><a:xfrm><a:off x="3000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="../media/image1.png" /></Relationships>',
    'ppt/media/image1.png': tinyPng(),
  });
}

/** yazl 生成真实 ZIP Buffer，避免把不透明二进制 Fixture 提交到仓库。 */
function zipEntries(entries: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  return zipEntryPairs(Object.entries(entries));
}

/** 允许安全测试刻意生成同名条目的底层 ZIP Helper。 */
function zipEntryPairs(
  entries: readonly (readonly [string, string | Uint8Array])[],
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name);
    zip.end();
  });
}

/** 修改测试 ZIP 的本地头和中央目录加密位；无需引入真实密码或敏感 Fixture。 */
function markFirstZipEntryEncrypted(bytes: Uint8Array): Uint8Array {
  const result = Buffer.from(bytes);
  const localHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const centralHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (localHeader < 0 || centralHeader < 0) throw new Error('测试 ZIP 缺少标准头');
  result.writeUInt16LE(result.readUInt16LE(localHeader + 6) | 0x1, localHeader + 6);
  result.writeUInt16LE(result.readUInt16LE(centralHeader + 8) | 0x1, centralHeader + 8);
  return result;
}

/** 1×1 透明 PNG，用于图片尺寸与内嵌媒体测试。 */
function tinyPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

/** 构造只包含 SOF0 尺寸段的最小 JPEG 头。 */
function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(21);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  return bytes;
}

/** 构造 GIF89a Logical Screen Descriptor。 */
function gifHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/** 构造小端 TIFF 首个 IFD 的宽高 LONG 条目。 */
function tiffHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(38);
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(256, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(width, 18);
  bytes.writeUInt16LE(257, 22);
  bytes.writeUInt16LE(4, 24);
  bytes.writeUInt32LE(1, 26);
  bytes.writeUInt32LE(height, 30);
  return bytes;
}

/** 构造 BITMAPINFOHEADER 尺寸字段。 */
function bmpHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(26);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  return bytes;
}

/** 构造 WebP VP8X 画布头，宽高字段保存 value-1。 */
function webpHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

/** 生成带正确 xref 偏移的最小文本 PDF。 */
function simplePdf(text: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length + 32} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'ascii');
}
