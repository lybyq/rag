/** 文件解析与OCR 编排测试：真实字节哈希、按页 OCR、安全拒绝、派生快照和故障分类。 */
import type {
  DocumentProcessingRepository,
  MalwareScannerPort,
  ObjectStoragePort,
  OcrPort,
  ParserPort,
} from '.';
import type { DocumentParseRun, ParserResult } from '@rag/contracts';
import { createHash } from 'node:crypto';
import { DocumentProcessingService } from './document-processing.service';

const inputBytes = Buffer.from('%PDF-1.7\nenterprise rag');
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex');
const now = new Date().toISOString();
const run: DocumentParseRun = {
  id: '0198a8f4-12f8-7000-8000-111111111111',
  jobId: 'job-1',
  providerProfile: 'test',
  documentVersionId: '0198a8f4-12f8-7000-8000-222222222222',
  contentRevision: 1,
  status: 'RUNNING',
  fileFormat: null,
  declaredMime: 'application/pdf',
  detectedMime: null,
  inputSha256: null,
  securityVerdict: null,
  malwareEngine: null,
  malwareRevision: null,
  parserProfileId: 'parser-profile',
  parserRevision: 'parser-r1',
  ocrProfileId: 'ocr-profile',
  ocrRevision: 'ocr-r1',
  pageCount: 0,
  blockCount: 0,
  ocrPageCount: 0,
  derivedBucket: null,
  derivedObjectKey: null,
  derivedSha256: null,
  failureClass: null,
  failureCode: null,
  failureMessage: null,
  metrics: {},
  startedAt: now,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};

const parserResult: ParserResult = {
  parserName: 'test-parser',
  parserRevision: 'parser-r1',
  protocolVersion: '1',
  blocks: [
    {
      type: 'PARAGRAPH',
      text: '可靠文字页',
      originalText: '可靠文字页',
      pageNo: 1,
      sheetName: null,
      slideNo: null,
      bbox: null,
      headingLevel: null,
      confidence: null,
      table: null,
      metadata: {},
    },
    {
      type: 'PARAGRAPH',
      text: '错误的扫描页占位',
      originalText: '错误的扫描页占位',
      pageNo: 2,
      sheetName: null,
      slideNo: null,
      bbox: null,
      headingLevel: null,
      confidence: null,
      table: null,
      metadata: {},
    },
  ],
  pages: [
    { pageNo: 1, textCharacterCount: 500, textCoverage: 0.5, imageOnly: false },
    { pageNo: 2, textCharacterCount: 0, textCoverage: 0, imageOnly: true },
  ],
  ocrCandidates: [],
  inspection: {
    encrypted: false,
    hasMacros: false,
    embeddedObjectCount: 0,
    externalLinkCount: 0,
    archiveDepth: null,
    compressedSizeBytes: null,
    uncompressedSizeBytes: null,
    pageCount: 2,
    totalPixels: null,
    tableCellCount: 0,
  },
  durationMs: 5,
  warnings: [],
};

function fixture(malwareVerdict: 'CLEAN' | 'INFECTED' = 'CLEAN'): {
  service: DocumentProcessingService;
  repository: jest.Mocked<DocumentProcessingRepository>;
  storage: jest.Mocked<ObjectStoragePort>;
  ocr: jest.Mocked<OcrPort>;
  parser: jest.Mocked<ParserPort>;
} {
  const repository = {
    loadInput: jest.fn().mockResolvedValue({
      jobId: 'job-1',
      documentId: '0198a8f4-12f8-7000-8000-333333333333',
      documentVersionId: run.documentVersionId,
      contentRevision: 1,
      attempt: 1,
      fileId: '0198a8f4-12f8-7000-8000-444444444444',
      originalFileName: 'policy.pdf',
      bucket: 'rag-quarantine',
      objectKey: 'isolated/object',
      sizeBytes: inputBytes.byteLength,
      declaredMime: 'application/pdf',
      uploadedSha256: inputSha256,
    }),
    beginRun: jest.fn().mockResolvedValue(run),
    recordPreflight: jest.fn().mockResolvedValue(undefined),
    recordSecurity: jest.fn().mockResolvedValue(undefined),
    startStep: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
    waitForManualReview: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DocumentProcessingRepository>;
  const storage = {
    readObject: jest.fn().mockResolvedValue(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield inputBytes;
      })(),
    ),
    presignGet: jest.fn().mockResolvedValue('http://minio.test/policy.pdf?temporary=true'),
    ensureNamedBucket: jest.fn().mockResolvedValue(undefined),
    headObject: jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'NoSuchKey' })),
    putObject: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ObjectStoragePort>;
  const scanner = {
    profile: jest.fn().mockReturnValue({
      kind: 'MALWARE_SCANNER',
      adapter: 'fixture',
      profileId: 'scanner-profile',
      revision: 'scanner-r1',
      protocolVersion: '1',
      endpoint: null,
      capabilities: [],
      timeoutMs: 1_000,
    }),
    scan: jest.fn(async (content: AsyncIterable<Uint8Array>, signal: AbortSignal) => {
      void signal;
      let bytes = 0;
      for await (const chunk of content) bytes += chunk.byteLength;
      return {
        verdict: malwareVerdict,
        engine: 'scanner',
        engineRevision: 'scanner-r1',
        signatureName: malwareVerdict === 'INFECTED' ? 'EICAR' : null,
        scannedBytes: bytes,
        durationMs: 1,
      };
    }),
  } as jest.Mocked<MalwareScannerPort>;
  const parser = {
    profile: jest.fn().mockReturnValue({
      kind: 'PARSER',
      adapter: 'fixture',
      profileId: 'parser-profile',
      revision: 'parser-r1',
      protocolVersion: '1',
      endpoint: null,
      capabilities: [],
      timeoutMs: 1_000,
    }),
    parse: jest.fn().mockResolvedValue(parserResult),
  } as unknown as jest.Mocked<ParserPort>;
  const ocr = {
    profile: jest.fn().mockReturnValue({
      kind: 'OCR',
      adapter: 'fixture',
      profileId: 'ocr-profile',
      revision: 'ocr-r1',
      protocolVersion: '1',
      endpoint: null,
      capabilities: [],
      timeoutMs: 1_000,
    }),
    recognize: jest.fn().mockResolvedValue({
      engine: 'test-ocr',
      engineRevision: 'ocr-r1',
      protocolVersion: '1',
      results: [
        {
          targetId: 'page-2',
          pageNo: 2,
          averageConfidence: 0.7,
          blocks: [
            {
              type: 'PARAGRAPH',
              text: 'OCR 扫描页',
              originalText: 'OCR  扫描页',
              pageNo: 2,
              sheetName: null,
              slideNo: null,
              bbox: null,
              headingLevel: null,
              confidence: 0.7,
              table: null,
              metadata: { extractionSource: 'OCR', sourceTargetId: 'page-2' },
            },
          ],
        },
      ],
      durationMs: 8,
      warnings: [],
    }),
  } as unknown as jest.Mocked<OcrPort>;
  return {
    repository,
    storage,
    ocr,
    parser,
    service: new DocumentProcessingService(repository, storage, scanner, parser, ocr, {
      providerProfile: 'test',
      derivedBucket: 'rag-derived',
      presignedGetTtlSeconds: 300,
      storageTimeoutMs: 1_000,
      objectStreamTimeoutMs: 10_000,
      ocrTextCoverageThreshold: 0.02,
      ocrMinConfidence: 0.75,
      maxAttempts: 3,
      maxArchiveDepth: 3,
      maxCompressionRatio: 100,
      maxPages: 2_000,
      maxTotalPixels: 500_000_000,
      maxTableCells: 5_000_000,
    }),
  };
}

describe('[CFG-007] DocumentProcessingService', () => {
  it('[PAR-016] 低置信 PAGE OCR 保留原生内容并停在人工审核', async () => {
    const { service, repository, storage, ocr } = fixture();
    await expect(service.process('job-1', 'worker-1')).resolves.toBe('MANUAL_REVIEW');
    expect(repository.beginRun).toHaveBeenCalledWith(
      expect.objectContaining({ providerProfile: 'test' }),
    );
    expect(ocr.recognize).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ targetId: 'page-2', kind: 'PAGE', pageNo: 2 })],
      expect.any(AbortSignal),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'rag-derived',
      expect.stringContaining('/content-r1/'),
      expect.objectContaining({
        contentType: 'application/json',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.anything(),
    );
    const completed = repository.complete.mock.calls[0]?.[0];
    expect(completed?.blocks.map((block) => block.originalText)).toEqual([
      '可靠文字页',
      '错误的扫描页占位',
    ]);
    expect(completed).toMatchObject({ requiresManualReview: true });
    expect(completed?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OCR_LOW_CONFIDENCE',
          pageNo: 2,
          severity: 'ERROR',
        }),
      ]),
    );
  });

  it('[PAR-007][PAR-008][PAR-010][PAR-012][PAR-016][PAR-024] 可靠 PAGE OCR 才替换原生页并继续下游', async () => {
    const { service, repository, ocr, storage } = fixture();
    ocr.recognize.mockResolvedValue({
      engine: 'test-ocr',
      engineRevision: 'ocr-r1',
      protocolVersion: '1',
      results: [
        {
          targetId: 'page-2',
          pageNo: 2,
          averageConfidence: 0.9,
          blocks: [
            {
              type: 'PARAGRAPH',
              text: '可靠 OCR 扫描页',
              originalText: '可靠 OCR 扫描页',
              pageNo: 2,
              sheetName: null,
              slideNo: null,
              bbox: null,
              headingLevel: null,
              confidence: 0.9,
              table: null,
              metadata: { extractionSource: 'OCR', sourceTargetId: 'page-2' },
            },
          ],
        },
      ],
      durationMs: 8,
      warnings: [],
    });
    await expect(service.process('job-1', 'worker-1')).resolves.toBe('COMPLETED');
    const completed = repository.complete.mock.calls[0]?.[0];
    expect(completed?.blocks.map((block) => block.text)).toEqual(['可靠文字页', '可靠 OCR 扫描页']);
    expect(completed).toMatchObject({ requiresManualReview: false });
    expect(storage.headObject).toHaveBeenCalledWith(
      'rag-derived',
      expect.stringContaining('/parser-parser-profile/revision-parser-r1/blocks.json'),
      expect.anything(),
    );
  });

  it.each([
    ['缺失', [], 'OCR_RESULT_MISSING'],
    [
      '空结果',
      [{ targetId: 'page-2', pageNo: 2, averageConfidence: 0.99, blocks: [] }],
      'OCR_EMPTY_RESULT',
    ],
  ])('[PAR-016] OCR %s时保留原生页并记录问题', async (_name, results, issueCode) => {
    const { service, repository, ocr } = fixture();
    ocr.recognize.mockResolvedValue({
      engine: 'test-ocr',
      engineRevision: 'ocr-r1',
      protocolVersion: '1',
      results,
      durationMs: 8,
      warnings: [],
    });
    await expect(service.process('job-1', 'worker-1')).resolves.toBe('MANUAL_REVIEW');
    const completed = repository.complete.mock.calls[0]?.[0];
    expect(completed?.blocks.map((block) => block.text)).toContain('错误的扫描页占位');
    expect(completed?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: issueCode, pageNo: 2 })]),
    );
  });

  it('[PAR-016] OCR 部分成功只替换成功页，缺失页保留原文并阻止进入 Chunk', async () => {
    const { service, repository, parser, ocr } = fixture();
    parser.parse.mockResolvedValue({
      ...parserResult,
      blocks: [
        ...parserResult.blocks,
        {
          ...parserResult.blocks[1]!,
          text: '第三页原生占位',
          originalText: '第三页原生占位',
          pageNo: 3,
        },
      ],
      pages: [
        ...parserResult.pages,
        { pageNo: 3, textCharacterCount: 0, textCoverage: 0, imageOnly: true },
      ],
      inspection: { ...parserResult.inspection, pageCount: 3 },
    });
    ocr.recognize.mockResolvedValue({
      engine: 'test-ocr',
      engineRevision: 'ocr-r1',
      protocolVersion: '1',
      results: [
        {
          targetId: 'page-2',
          pageNo: 2,
          averageConfidence: 0.9,
          blocks: [
            {
              ...parserResult.blocks[1]!,
              text: '第二页可靠 OCR',
              originalText: '第二页可靠 OCR',
              confidence: 0.9,
              metadata: { extractionSource: 'OCR', sourceTargetId: 'page-2' },
            },
          ],
        },
      ],
      durationMs: 8,
      warnings: [],
    });

    await expect(service.process('job-1', 'worker-1')).resolves.toBe('MANUAL_REVIEW');
    const completed = repository.complete.mock.calls[0]?.[0];
    expect(completed?.blocks.map((block) => block.text)).toEqual([
      '可靠文字页',
      '第二页可靠 OCR',
      '第三页原生占位',
    ]);
    expect(completed?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'OCR_RESULT_MISSING', pageNo: 3 })]),
    );
    expect(completed?.ocrOutcomeCounts).toEqual({ SUCCESS: 1, MISSING: 1 });
  });

  it('[PAR-002][PAR-003] 命中恶意软件后拒绝，不写 derived Bucket', async () => {
    const { service, repository, storage, ocr, parser } = fixture('INFECTED');
    await expect(service.process('job-1', 'worker-1')).resolves.toBe('REJECTED');
    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: 'DOCUMENT_PROBLEM',
        failureCode: 'MALWARE_DETECTED',
      }),
    );
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(parser.parse).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
