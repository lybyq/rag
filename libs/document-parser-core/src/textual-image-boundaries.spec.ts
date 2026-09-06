/**
 * TXT、CSV 与图片边界的公开合成回归测试。
 * 重点验证编码、原始换行、表头推断、多行字段、不规则行、多帧/多页和方向事实；
 * 不依赖企业文档，也不把“只读到第一帧”误判为完整成功。
 *
 * @requirement PAR-023
 */
import { createDocumentParserRegistry } from './index';
import { inspectImage } from './image-dimensions';
import type { ParserResult } from '@rag/contracts';

const limits = {
  maxArchiveDepth: 3,
  maxCompressionRatio: 100,
  maxPages: 100,
  maxTotalPixels: 10_000_000,
  maxTableCells: 100_000,
  maxExpandedTableCells: 100_000,
  maxTableRows: 10_000,
  maxTableColumns: 1_000,
  maxTableSpan: 1_000,
  maxOutputCharacters: 10_000_000,
  maxInputBytes: 10 * 1024 * 1024,
  maxArchiveEntries: 1_000,
  maxXmlEntryBytes: 2 * 1024 * 1024,
};
const registry = createDocumentParserRegistry(limits, {
  revision: 'text-image-boundary-r1',
  protocolVersion: '2',
});
const signal = new AbortController().signal;

describe('[PAR-023] TXT 编码、换行和段落边界', () => {
  it.each([
    ['UTF-16LE', utf16LeBom('第一行\r\n第二行\r\n\r\n第三段')],
    ['UTF-16BE', utf16BeBom('第一行\n第二行\n\n第三段')],
  ])('%s BOM 被严格解码，正文行不被臆造成标题', async (_name, bytes) => {
    const parsed = await parse('TEXT', bytes, 'sample.txt', 'text/plain');

    expect(parsed.blocks.map((block) => block.type)).toEqual(['PARAGRAPH', 'PARAGRAPH']);
    expect(parsed.blocks[0]).toMatchObject({
      text: '第一行\n第二行',
      headingLevel: null,
      metadata: expect.objectContaining({
        paragraphPolicy: 'BLANK_LINE_V1',
        lineStart: 1,
        lineEnd: 2,
      }),
    });
    expect(parsed.blocks[0]?.originalText).toMatch(/^第一行(?:\r\n|\n)第二行$/u);
  });

  it('混合 CRLF/LF/CR 使用空白行分段，并保留每段原始换行事实', async () => {
    const parsed = await parse(
      'TEXT',
      Buffer.from('甲\r\n乙\n\n丙\r丁\r\r戊', 'utf8'),
      'mixed.txt',
      'text/plain',
    );

    expect(parsed.blocks.map((block) => block.text)).toEqual(['甲\n乙', '丙\n丁', '戊']);
    expect(parsed.blocks.map((block) => block.originalText)).toEqual(['甲\r\n乙', '丙\r丁', '戊']);
    expect(parsed.warnings).toContain('TEXT_MIXED_NEWLINE_STYLES');
  });

  it.each([
    ['奇数字节 UTF-16', Buffer.from([0xff, 0xfe, 0x41])],
    ['非法 UTF-8', Buffer.from([0xc3, 0x28])],
    ['无 BOM 的 NUL 二进制', Buffer.from([0x41, 0x00, 0x42])],
  ])('%s 明确拒绝', async (_name, bytes) => {
    await expect(parse('TEXT', bytes, 'broken.txt', 'text/plain')).rejects.toMatchObject({
      code: expect.stringMatching(/^TEXT_(ENCODING|BINARY)/u),
    });
  });
});

describe('[PAR-023] CSV 方言、表头和不规则记录边界', () => {
  it('自动识别分号，保留引号内分隔符和跨行字段，并用强证据识别表头', async () => {
    const parsed = await parse(
      'CSV',
      Buffer.from('name;age;note\r\nAlice;30;"line 1\nline;2"\r\nBob;41;ok', 'utf8'),
      'semicolon.csv',
      'text/csv',
    );
    const block = parsed.blocks[0];

    expect(block?.table).toEqual({
      rows: [
        ['name', 'age', 'note'],
        ['Alice', '30', 'line 1\nline;2'],
        ['Bob', '41', 'ok'],
      ],
      headerRowCount: 1,
      mergedCells: [],
    });
    expect(block?.metadata).toMatchObject({
      delimiter: ';',
      delimiterDetectionRevision: 'csv-delimiter-v1',
      headerDetectionRevision: 'csv-header-v1',
      headerConfidence: expect.any(Number),
    });
  });

  it('无可靠表头时保留首行，不规则列补齐并对空记录给出可见事实', async () => {
    const parsed = await parse(
      'CSV',
      Buffer.from('1,2\n\n3,4,5\n6', 'utf8'),
      'irregular.csv',
      'text/csv',
    );
    const block = parsed.blocks[0];

    expect(block?.table).toEqual({
      rows: [
        ['1', '2', ''],
        ['', '', ''],
        ['3', '4', '5'],
        ['6', '', ''],
      ],
      headerRowCount: 0,
      mergedCells: [],
    });
    expect(block?.metadata).toMatchObject({
      sourceRowWidths: [2, 1, 3, 1],
      irregularRowCount: 3,
      emptyRecordCount: 1,
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining(['CSV_IRREGULAR_COLUMN_COUNT', 'CSV_HEADER_NOT_CONFIDENT']),
    );
    expect(parsed.inspection).toMatchObject({ tableCellCount: 7, expandedTableCellCount: 12 });
  });

  it('引号未闭合的损坏记录不会返回部分表格', async () => {
    await expect(
      parse('CSV', Buffer.from('a,b\n1,"broken', 'utf8'), 'broken.csv', 'text/csv'),
    ).rejects.toMatchObject({ code: 'CSV_CONTENT_INVALID' });
  });
});

describe('[PAR-023] 图片多页、多帧、方向和累计像素边界', () => {
  it('完整枚举多页 TIFF 尺寸与方向，但 Parser 明确拒绝未支持的多页语义', async () => {
    const bytes = multipageTiff([
      { width: 3, height: 4, orientation: 1 },
      { width: 5, height: 6, orientation: 6 },
    ]);
    expect(inspectImage(bytes)).toMatchObject({
      type: 'tiff',
      width: 3,
      height: 4,
      contentUnitKind: 'PAGE',
      unitCount: 2,
      orientation: 1,
      units: [
        { width: 3, height: 4, orientation: 1 },
        { width: 5, height: 6, orientation: 6 },
      ],
    });
    await expect(parse('IMAGE', bytes, 'pages.tiff', 'image/tiff')).rejects.toMatchObject({
      code: 'IMAGE_MULTIPAGE_TIFF_UNSUPPORTED',
    });
  });

  it('动画 GIF 不静默按首帧成功，并按全部帧累计像素预算', async () => {
    const bytes = animatedGif(3, 4, 2);
    expect(inspectImage(bytes)).toMatchObject({
      type: 'gif',
      animated: true,
      contentUnitKind: 'FRAME',
      unitCount: 2,
    });
    await expect(parse('IMAGE', bytes, 'animated.gif', 'image/gif')).rejects.toMatchObject({
      code: 'IMAGE_ANIMATION_UNSUPPORTED',
    });

    const constrained = createDocumentParserRegistry(
      { ...limits, maxTotalPixels: 20 },
      { revision: 'pixel-boundary-r1', protocolVersion: '2' },
    );
    await expect(
      constrained.parse(
        {
          bytes,
          fileName: 'animated.gif',
          format: 'IMAGE',
          declaredMime: 'image/gif',
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'PIXEL_LIMIT_EXCEEDED' });
  });

  it('JPEG EXIF 方向作为事实保留；未旋转像素时返回明确告警', async () => {
    const parsed = await parse('IMAGE', orientedJpeg(3, 4, 6), 'rotated.jpg', 'image/jpeg');

    expect(parsed.blocks[0]?.metadata).toMatchObject({ orientation: 6, orientationApplied: false });
    expect(parsed.warnings).toContain('IMAGE_ORIENTATION_NOT_APPLIED');
  });

  it('截断或损坏的图片头明确拒绝', async () => {
    await expect(
      parse('IMAGE', Buffer.from([0x47, 0x49, 0x46, 0x38]), 'broken.gif', 'image/gif'),
    ).rejects.toMatchObject({ code: 'IMAGE_HEADER_INVALID' });
  });
});

/** 通过统一 Registry 运行边界样本，确保最终 Zod 契约也被验证。 */
function parse(
  format: 'TEXT' | 'CSV' | 'IMAGE',
  bytes: Uint8Array,
  fileName: string,
  declaredMime: string,
): Promise<ParserResult> {
  return registry.parse({ format, bytes, fileName, declaredMime }, signal);
}

/** 构造带 BOM 的 UTF-16LE；Node Buffer 只负责公开测试数据编码。 */
function utf16LeBom(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** 构造带 BOM 的 UTF-16BE：先编码 LE，再逐代码单元交换字节。 */
function utf16BeBom(text: string): Uint8Array {
  const little = Buffer.from(text, 'utf16le');
  const big = Buffer.alloc(little.byteLength + 2);
  big[0] = 0xfe;
  big[1] = 0xff;
  for (let index = 0; index < little.byteLength; index += 2) {
    big[index + 2] = little[index + 1] ?? 0;
    big[index + 3] = little[index] ?? 0;
  }
  return big;
}

/** 生成具有两个及以上 IFD 的小端 TIFF，每个 IFD 都含宽、高和 Orientation。 */
function multipageTiff(
  pages: readonly {
    readonly width: number;
    readonly height: number;
    readonly orientation: number;
  }[],
): Uint8Array {
  const directorySize = 2 + 3 * 12 + 4;
  const bytes = Buffer.alloc(8 + pages.length * directorySize);
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  pages.forEach((page, pageIndex) => {
    const offset = 8 + pageIndex * directorySize;
    bytes.writeUInt16LE(3, offset);
    writeTiffLongEntry(bytes, offset + 2, 256, page.width);
    writeTiffLongEntry(bytes, offset + 14, 257, page.height);
    writeTiffShortEntry(bytes, offset + 26, 274, page.orientation);
    bytes.writeUInt32LE(pageIndex + 1 < pages.length ? offset + directorySize : 0, offset + 38);
  });
  return bytes;
}

/** 写入 count=1 的 TIFF LONG 测试条目。 */
function writeTiffLongEntry(bytes: Buffer, offset: number, tag: number, value: number): void {
  bytes.writeUInt16LE(tag, offset);
  bytes.writeUInt16LE(4, offset + 2);
  bytes.writeUInt32LE(1, offset + 4);
  bytes.writeUInt32LE(value, offset + 8);
}

/** 写入 count=1 的 TIFF SHORT 测试条目。 */
function writeTiffShortEntry(bytes: Buffer, offset: number, tag: number, value: number): void {
  bytes.writeUInt16LE(tag, offset);
  bytes.writeUInt16LE(3, offset + 2);
  bytes.writeUInt32LE(1, offset + 4);
  bytes.writeUInt16LE(value, offset + 8);
}

/** 生成只用于结构扫描的合法双帧 GIF；帧数据不需要真正解码。 */
function animatedGif(width: number, height: number, frameCount: number): Uint8Array {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80;
  chunks.push(header, Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]));
  for (let index = 0; index < frameCount; index += 1) {
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    chunks.push(descriptor, Buffer.from([2, 2, 0x4c, 0x01, 0]));
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

/** 生成带最小 EXIF Orientation 和 SOF0 尺寸的 JPEG。 */
function orientedJpeg(width: number, height: number, orientation: number): Uint8Array {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  writeTiffShortEntry(tiff, 10, 274, orientation);
  tiff.writeUInt32LE(0, 22);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(exif.byteLength + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(exif.byteLength + 2, 2);
  exif.copy(app1, 4);
  const sof = Buffer.alloc(19);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(sof);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
