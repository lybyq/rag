/** M03 领域规则测试：格式可信识别、安全 fail-closed、按页 OCR 与稳定 Block。 */
import {
  FileRejectedError,
  buildDerivedSnapshotKey,
  buildDocumentBlocks,
  detectFileFormat,
  evaluateFileSecurity,
  selectOcrPages,
} from '.';

describe('[PAR-001][PAR-003][PAR-007][PAR-010][PAR-012] parser core', () => {
  it('以魔数为真相识别 PDF，并拒绝声明为图片的伪装扩展名', () => {
    const pdfHeader = new TextEncoder().encode('%PDF-1.7\n');

    expect(detectFileFormat(pdfHeader, 'guide.pdf', 'application/pdf')).toEqual({
      format: 'PDF',
      detectedMime: 'application/pdf',
      warnings: [],
    });
    expect(() => detectFileFormat(pdfHeader, 'avatar.png', 'image/png')).toThrow(FileRejectedError);
  });

  it('ZIP 容器必须由 Office 扩展名和 MIME 共同收窄，不能笼统当成安全压缩包', () => {
    const zipHeader = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

    expect(
      detectFileFormat(
        zipHeader,
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ).format,
    ).toBe('DOCX');
    expect(() => detectFileFormat(zipHeader, 'archive.zip', 'application/zip')).toThrow(
      /不支持的 ZIP 容器/,
    );
  });

  it('恶意、密码、宏和资源炸弹一律拒绝；只有外链时进入人工检查', () => {
    const base = {
      encrypted: false,
      hasMacros: false,
      embeddedObjectCount: 0,
      externalLinkCount: 0,
      archiveDepth: 1,
      compressedSizeBytes: 100,
      uncompressedSizeBytes: 1_000,
      pageCount: 2,
      totalPixels: 1_000,
      tableCellCount: 20,
    } as const;
    const limits = {
      maxArchiveDepth: 3,
      maxCompressionRatio: 100,
      maxPages: 100,
      maxTotalPixels: 1_000_000,
      maxTableCells: 10_000,
    } as const;

    expect(
      evaluateFileSecurity(
        { ...base, externalLinkCount: 1 },
        { verdict: 'CLEAN', signatureName: null },
        limits,
      ).verdict,
    ).toBe('MANUAL_REVIEW');
    for (const inspection of [
      { ...base, encrypted: true },
      { ...base, hasMacros: true },
      { ...base, archiveDepth: 4 },
      { ...base, uncompressedSizeBytes: 20_000 },
    ]) {
      expect(
        evaluateFileSecurity(inspection, { verdict: 'CLEAN', signatureName: null }, limits).verdict,
      ).toBe('REJECTED');
    }
    expect(
      evaluateFileSecurity(base, { verdict: 'INFECTED', signatureName: 'Eicar-Test' }, limits)
        .verdict,
    ).toBe('REJECTED');
  });

  it('只选择低覆盖或纯图片页执行 OCR，不因单页扫描件重做整本 PDF', () => {
    expect(
      selectOcrPages(
        [
          { pageNo: 1, textCharacterCount: 800, textCoverage: 0.3, imageOnly: false },
          { pageNo: 2, textCharacterCount: 0, textCoverage: 0, imageOnly: true },
          { pageNo: 3, textCharacterCount: 12, textCoverage: 0.01, imageOnly: false },
        ],
        0.02,
      ),
    ).toEqual([2, 3]);
  });

  it('标准化保留 originalText，并为相同修订生成稳定 ID 与版本化派生路径', () => {
    const input = {
      parseRunId: '2b9d47dc-6de2-4ce7-a4b0-287f58d3c76d',
      documentVersionId: 'f243c144-c561-4f51-a7cb-f4c29f426199',
      contentRevision: 2,
      parserName: 'docling',
      parserRevision: '1.21.0',
      candidates: [
        {
          type: 'PARAGRAPH' as const,
          text: '  第一行\r\n  第二行  ',
          originalText: '  第一行\r\n  第二行  ',
          pageNo: 1,
          sheetName: null,
          slideNo: null,
          bbox: null,
          headingLevel: null,
          confidence: null,
          table: null,
          metadata: {},
        },
      ],
    };

    const first = buildDocumentBlocks(input);
    const second = buildDocumentBlocks(input);
    expect(first).toEqual(second);
    expect(first[0]?.text).toBe('第一行\n第二行');
    expect(first[0]?.originalText).toBe('  第一行\r\n  第二行  ');
    expect(
      buildDerivedSnapshotKey(input.documentVersionId, input.contentRevision, 'docling-v1'),
    ).toBe('derived/f243c144-c561-4f51-a7cb-f4c29f426199/content-r2/parser-docling-v1/blocks.json');
  });
});
