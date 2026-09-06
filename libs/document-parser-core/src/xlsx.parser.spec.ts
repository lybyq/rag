/**
 * XLSX 内容事实回归：验证媒体索引、重复出现、多表区域、公式结果和显示格式。
 * Fixture 全部由 ExcelJS 在内存生成，不包含企业数据。
 *
 * @requirement PAR-019
 */
import ExcelJS from 'exceljs';
import type { ParserResult } from '@rag/contracts';
import { ZipFile } from 'yazl';
import { createDocumentParserRegistry, readSafeOfficeArchive } from './index';

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
  revision: 'xlsx-facts-r1',
  protocolVersion: '2',
});

describe('[PAR-019] XLSX media and table facts', () => {
  it('imageId=0、多图 image2/image10 与重复引用都映射到真实媒体，不按文件名字典序猜测', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('图片');
    sheet.addRow(['图片清单']);
    const imageIds = Array.from({ length: 10 }, () =>
      workbook.addImage({ buffer: Buffer.from(tinyPng()) as never, extension: 'png' }),
    );
    imageIds.forEach((imageId, index) => sheet.addImage(imageId, `A${index + 1}:B${index + 1}`));
    sheet.addImage(imageIds[0] as number, 'C1:D1');

    const result = await parseWorkbook(workbook);
    const paths = result.ocrCandidates.map((target) => target.assetRef?.archiveEntryPath);
    expect(paths).toEqual([
      'xl/media/image1.png',
      'xl/media/image2.png',
      'xl/media/image3.png',
      'xl/media/image4.png',
      'xl/media/image5.png',
      'xl/media/image6.png',
      'xl/media/image7.png',
      'xl/media/image8.png',
      'xl/media/image9.png',
      'xl/media/image10.png',
      'xl/media/image1.png',
    ]);
    expect(new Set(result.ocrCandidates.map((target) => target.targetId))).toHaveProperty(
      'size',
      11,
    );
    expect(
      result.blocks.filter(
        (block) =>
          block.type === 'IMAGE' && block.metadata.archiveEntryPath === 'xl/media/image1.png',
      ),
    ).toHaveLength(2);
  });

  it('公式缺少缓存结果时留空并告警，同时保留百分比、货币、日期和前导零语义', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('格式');
    sheet.addRow(['编码', '比例', '金额', '待计算', '日期']);
    sheet.addRow(['0012', 0.125, 1234.5, { formula: '1+1' }, new Date('2026-01-02T00:00:00.000Z')]);
    sheet.getCell('B2').numFmt = '0.0%';
    sheet.getCell('C2').numFmt = '$#,##0.00';
    sheet.getCell('E2').numFmt = 'yyyy-mm-dd';

    const result = await parseWorkbook(workbook);
    const table = result.blocks.find((block) => block.type === 'TABLE');
    expect(table?.table?.rows[1]).toEqual([
      '0012',
      '12.5%',
      '$1,234.50',
      '',
      '2026-01-02T00:00:00.000Z',
    ]);
    expect(table?.metadata.formulas).toEqual([
      expect.objectContaining({
        cell: 'D2',
        formula: '1+1',
        result: null,
        resultStatus: 'MISSING',
      }),
    ]);
    expect(table?.metadata.formattedCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cell: 'B2', numberFormat: '0.0%', displayText: '12.5%' }),
        expect.objectContaining({
          cell: 'C2',
          numberFormat: '$#,##0.00',
          displayText: '$1,234.50',
        }),
      ]),
    );
    expect(result.warnings).toContain('XLSX_FORMULA_RESULT_MISSING');
  });

  it('媒体文件名不连续时仍跟随 drawing relationship，而不是回退到排序位置', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('非连续媒体');
    sheet.addRow(['图片']);
    const first = workbook.addImage({ buffer: Buffer.from(tinyPng()) as never, extension: 'png' });
    const second = workbook.addImage({ buffer: Buffer.from(tinyPng()) as never, extension: 'png' });
    sheet.addImage(first, 'A1:B1');
    sheet.addImage(second, 'C1:D1');
    const original = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBufferLike);
    const renamed = await renameSecondMedia(original);
    const result = await parseBytes(renamed);

    expect(result.ocrCandidates.map((target) => target.assetRef?.archiveEntryPath)).toEqual([
      'xl/media/image1.png',
      'xl/media/picture42.png',
    ]);
  });

  it('空白列把同一 Sheet 的并排业务表拆成两个区域，并分别推断表头', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('双表');
    sheet.getCell('A1').value = '部门';
    sheet.getCell('B1').value = '人数';
    sheet.getCell('A2').value = '研发';
    sheet.getCell('B2').value = 3;
    sheet.getCell('D1').value = '地区';
    sheet.getCell('E1').value = '金额';
    sheet.getCell('D2').value = '华东';
    sheet.getCell('E2').value = 100;

    const result = await parseWorkbook(workbook);
    const tables = result.blocks.filter((block) => block.type === 'TABLE');
    expect(tables).toHaveLength(2);
    expect(tables.map((table) => table.table?.rows)).toEqual([
      [
        ['部门', '人数'],
        ['研发', '3'],
      ],
      [
        ['地区', '金额'],
        ['华东', '100'],
      ],
    ]);
    expect(tables.map((table) => table.table?.headerRowCount)).toEqual([1, 1]);
    expect(tables.map((table) => table.metadata.sourceRange)).toEqual(['A1:B2', 'D1:E2']);
  });

  it('稀疏行分区后合并坐标映射到输出行，并保留源行列映射', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('稀疏');
    sheet.getCell('A1').value = '独立说明';
    sheet.getCell('A10').value = '合并区域';
    sheet.mergeCells('A10:B10');

    const result = await parseWorkbook(workbook);
    const tables = result.blocks.filter((block) => block.type === 'TABLE');
    expect(tables).toHaveLength(2);
    expect(tables[1]).toMatchObject({
      table: {
        rows: [['合并区域', '']],
        mergedCells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
      },
      metadata: {
        sourceRange: 'A10:B10',
        sourceRowNumbers: [10],
        sourceColumnNumbers: [1, 2],
      },
    });
  });
});

/** 把 ExcelJS 工作簿写成真实 OOXML 后通过完整 Registry 解析。 */
async function parseWorkbook(workbook: ExcelJS.Workbook): Promise<ParserResult> {
  const bytes = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBufferLike);
  return parseBytes(bytes);
}

/** 使用完整 Registry 解析已经构造好的 XLSX 字节。 */
async function parseBytes(bytes: Uint8Array): Promise<ParserResult> {
  return registry.parse(
    {
      bytes,
      fileName: 'facts.xlsx',
      format: 'XLSX',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    new AbortController().signal,
  );
}

/** 把 image2 重命名为非连续 picture42，并同步修改 drawing relationship。 */
async function renameSecondMedia(bytes: Uint8Array): Promise<Uint8Array> {
  const archive = await readSafeOfficeArchive(bytes, 'XLSX', limits, new AbortController().signal);
  const entries: [string, Uint8Array][] = [];
  for (const [name, content] of archive.entries) {
    const renamedName = name === 'xl/media/image2.png' ? 'xl/media/picture42.png' : name;
    const rewritten = name.endsWith('.rels')
      ? Buffer.from(
          new TextDecoder()
            .decode(content)
            .replaceAll('../media/image2.png', '../media/picture42.png'),
        )
      : content;
    entries.push([renamedName, rewritten]);
  }
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

/** 1×1 公开透明 PNG；十次注册用于制造 image10 与重复媒体引用。 */
function tinyPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}
