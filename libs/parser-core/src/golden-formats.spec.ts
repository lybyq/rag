/** M03 九类格式 Golden 清单：固定输入头、路由结果与统一 Block 契约。 */
import { FixtureOcrAdapter, FixtureParserAdapter } from '@rag/file-processing-providers';
import { OcrResultSchema, ParserResultSchema, type SupportedFileFormat } from '@rag/contracts';
import goldenManifest from '../../../test/fixtures/m03/golden-manifest.json';
import { detectFileFormat } from './file-detection';
import { selectOcrPages } from './block-normalization';

describe('[PAR-006][PAR-014] supported format golden manifest', () => {
  it.each(goldenManifest)('$name 路由到 $expectedFormat 并输出版本化统一契约', async (fixture) => {
    const header = fixture.headerHex
      ? Buffer.from(fixture.headerHex, 'hex')
      : Buffer.from(fixture.headerUtf8 ?? '', 'utf8');
    const detected = detectFileFormat(header, fixture.fileName, fixture.declaredMime);
    expect(detected.format).toBe(fixture.expectedFormat);

    const parser = new FixtureParserAdapter('golden-parser', 'golden-r1', '1', 1_000);
    const parsed = ParserResultSchema.parse(
      await parser.parse({
        url: 'http://golden.invalid/fixture',
        fileName: fixture.fileName,
        format: detected.format as SupportedFileFormat,
        declaredMime: fixture.declaredMime,
      }),
    );
    const ocrPages = selectOcrPages(parsed.pages, 0.02);
    if (ocrPages.length > 0) {
      const ocr = new FixtureOcrAdapter('golden-ocr', 'golden-r1', '1', 1_000);
      expect(
        OcrResultSchema.parse(
          await ocr.recognize(
            {
              url: 'http://golden.invalid/fixture',
              fileName: fixture.fileName,
              format: detected.format as SupportedFileFormat,
              declaredMime: fixture.declaredMime,
            },
            ocrPages,
          ),
        ).pages.map((page) => page.pageNo),
      ).toEqual(ocrPages);
    }
    expect({
      format: detected.format,
      parserRevision: parsed.parserRevision,
      blockTypes: parsed.blocks.map((block) => block.type),
      ocrPages,
    }).toMatchSnapshot();
  });
});
