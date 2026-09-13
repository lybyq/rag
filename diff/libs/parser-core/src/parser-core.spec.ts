/** 文件解析与OCR 领域规则测试：格式可信识别、安全 fail-closed、按页 OCR 与稳定 Block。 */
import {
  FileRejectedError,
  assessOcrTargetResults,
  buildDerivedSnapshotKey,
  buildDocumentBlocks,
  detectFileFormat,
  evaluateFileSecurity,
  mergeOcrBlocks,
  selectOcrPages,
  selectOcrTargets,
  selectSupportedOcrTargets,
} from '.';
import type { OcrTarget, ParsedBlockCandidate } from '@rag/contracts';

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

  it('[PAR-016] 只选择确定的纯图片页，正常短标题页不能仅因字符少触发 PAGE OCR', () => {
    expect(
      selectOcrPages(
        [
          { pageNo: 1, textCharacterCount: 800, textCoverage: 0.3, imageOnly: false },
          { pageNo: 2, textCharacterCount: 0, textCoverage: 0, imageOnly: true },
          { pageNo: 3, textCharacterCount: 12, textCoverage: 0.01, imageOnly: false },
        ],
        0.02,
      ),
    ).toEqual([2]);
    expect(
      selectOcrTargets(
        [{ pageNo: 1, textCharacterCount: 0, textCoverage: 0, imageOnly: true }],
        [],
        0.02,
        'PPTX',
      ),
    ).toEqual([]);
  });

  it('[PAR-016] PAGE OCR 只有实际成功且达到质量阈值时才替换原生页', () => {
    const target = pageTarget(2);
    const native = [block('原生占位', 2, 'NATIVE')];

    for (const results of [
      [],
      [{ targetId: target.targetId, pageNo: 2, blocks: [], averageConfidence: 0.99 }],
      [
        {
          targetId: target.targetId,
          pageNo: 2,
          blocks: [block('低置信 OCR', 2, 'OCR')],
          averageConfidence: 0.5,
        },
      ],
      [
        {
          targetId: target.targetId,
          pageNo: 2,
          blocks: [block('无置信度 OCR', 2, 'OCR')],
          averageConfidence: null,
        },
      ],
    ]) {
      const assessments = assessOcrTargetResults([target], results, 0.75);
      expect(mergeOcrBlocks(native, assessments).map((item) => item.text)).toEqual(['原生占位']);
    }

    expect(
      assessOcrTargetResults(
        [target],
        [
          {
            targetId: target.targetId,
            pageNo: 2,
            blocks: [block('无置信度 OCR', 2, 'OCR')],
            averageConfidence: null,
          },
        ],
        0.75,
      )[0]?.status,
    ).toBe('UNKNOWN_CONFIDENCE');

    const assessments = assessOcrTargetResults(
      [target],
      [
        {
          targetId: target.targetId,
          pageNo: 2,
          blocks: [block('可靠 OCR', 2, 'OCR')],
          averageConfidence: 0.9,
        },
      ],
      0.75,
    );
    expect(assessments[0]?.status).toBe('SUCCESS');
    expect(mergeOcrBlocks(native, assessments).map((item) => item.text)).toEqual(['可靠 OCR']);
  });

  it('[PAR-016] 图片和区域 OCR 只补充关联位置，不能删除同页原生正文', () => {
    const target: OcrTarget = {
      targetId: 'slide-1-image-1',
      kind: 'EMBEDDED_IMAGE',
      pageNo: 1,
      slideNo: 1,
      sheetName: null,
      bbox: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 },
      assetRef: null,
      reason: 'EMBEDDED_SCREENSHOT',
    };
    const native = [block('原生正文', 1, 'NATIVE')];
    const ocr = block('图片文字', 1, 'OCR', 1);
    const assessments = assessOcrTargetResults(
      [target],
      [{ targetId: target.targetId, pageNo: 1, blocks: [ocr], averageConfidence: 0.9 }],
      0.75,
    );
    expect(mergeOcrBlocks(native, assessments).map((item) => item.text)).toEqual([
      '原生正文',
      '图片文字',
    ]);
  });

  it('[PAR-021] DOCX 图片 OCR 紧跟出现位置，不统一追加到文档末尾', () => {
    const target: OcrTarget = {
      targetId: 'docx-image-occurrence-1',
      kind: 'EMBEDDED_IMAGE',
      pageNo: null,
      slideNo: null,
      sheetName: null,
      bbox: null,
      assetRef: null,
      reason: 'EMBEDDED_SCREENSHOT',
    };
    const image = {
      ...block('', null, 'NATIVE'),
      type: 'IMAGE' as const,
      metadata: { extractionSource: 'NATIVE', ocrTargetId: target.targetId },
    };
    const native = [
      block('图片前正文', null, 'NATIVE'),
      image,
      block('图片后正文', null, 'NATIVE'),
    ];
    const assessments = assessOcrTargetResults(
      [target],
      [
        {
          targetId: target.targetId,
          pageNo: null,
          blocks: [block('图片中的制度文字', null, 'OCR')],
          averageConfidence: 0.95,
        },
      ],
      0.75,
    );

    expect(mergeOcrBlocks(native, assessments).map((item) => item.text)).toEqual([
      '图片前正文',
      '',
      '图片中的制度文字',
      '图片后正文',
    ]);
  });

  it('[PAR-016] Provider 一旦声明目标能力，就不能收到未声明支持的目标', () => {
    const page = pageTarget(2);
    const image: OcrTarget = {
      ...page,
      targetId: 'docx-image-1',
      kind: 'EMBEDDED_IMAGE',
      pageNo: null,
      reason: 'EMBEDDED_SCREENSHOT',
    };
    expect(selectSupportedOcrTargets([page, image], ['PAGE_SELECTIVE'])).toEqual({
      supported: [page],
      unsupported: [image],
    });
    // 空数组表示旧 Provider 尚未声明能力，为兼容已调通的内网配置，保持原有目标集合。
    expect(selectSupportedOcrTargets([page, image], [])).toEqual({
      supported: [page, image],
      unsupported: [],
    });
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
      buildDerivedSnapshotKey(
        input.documentVersionId,
        input.contentRevision,
        'node-multi-parser-v1',
        '1.1.0',
      ),
    ).toBe(
      'derived/f243c144-c561-4f51-a7cb-f4c29f426199/content-r2/parser-node-multi-parser-v1/revision-1.1.0/blocks.json',
    );
    expect(
      buildDerivedSnapshotKey(
        input.documentVersionId,
        input.contentRevision,
        'node-multi-parser-v1',
        '1.0.0',
      ),
    ).not.toBe(
      buildDerivedSnapshotKey(
        input.documentVersionId,
        input.contentRevision,
        'node-multi-parser-v1',
        '1.1.0',
      ),
    );
  });
});

function pageTarget(pageNo: number): OcrTarget {
  return {
    targetId: `page-${pageNo}`,
    kind: 'PAGE',
    pageNo,
    slideNo: null,
    sheetName: null,
    bbox: null,
    assetRef: null,
    reason: 'IMAGE_ONLY',
  };
}

function block(
  text: string,
  pageNo: number | null,
  extractionSource: 'NATIVE' | 'OCR',
  slideNo: number | null = null,
): ParsedBlockCandidate {
  return {
    type: 'PARAGRAPH',
    text,
    originalText: text,
    pageNo,
    sheetName: null,
    slideNo,
    bbox: null,
    headingLevel: null,
    confidence: extractionSource === 'OCR' ? 0.9 : null,
    table: null,
    metadata: { extractionSource },
  };
}
