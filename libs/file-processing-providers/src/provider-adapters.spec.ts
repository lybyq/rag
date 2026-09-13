/** 文件解析与OCR Provider Port 契约测试：成功、429、Schema 漂移、版本漂移与内置流式安全扫描。 */
import type { OcrResult, OcrTarget, ParserResult } from '@rag/contracts';
import { BuiltinContentSafetyScannerAdapter } from './builtin-content-safety-scanner.adapter';
import { HttpOcrAdapter } from './http-ocr.adapter';
import { HttpParserAdapter } from './http-parser.adapter';
import type { ProcessingProviderError } from './provider.error';

const source = {
  url: 'http://object.test/file.pdf?temporary=true',
  fileName: 'file.pdf',
  format: 'PDF' as const,
  declaredMime: 'application/pdf',
};

const validResult: ParserResult = {
  parserName: 'internal-parser',
  parserRevision: '2026.08',
  protocolVersion: '1',
  blocks: [],
  pages: [{ pageNo: 1, textCharacterCount: 0, textCoverage: 0, imageOnly: true }],
  ocrCandidates: [],
  inspection: {
    encrypted: false,
    hasMacros: false,
    embeddedObjectCount: 0,
    externalLinkCount: 0,
    archiveDepth: null,
    compressedSizeBytes: null,
    uncompressedSizeBytes: null,
    pageCount: 1,
    totalPixels: null,
    tableCellCount: 0,
  },
  durationMs: 10,
  warnings: [],
};

function adapter(fetchImplementation: typeof fetch): HttpParserAdapter {
  return new HttpParserAdapter(
    {
      baseUrl: 'http://parser.test/',
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      maxAttempts: 3,
      profileId: 'parser-v1',
      revision: '2026.08',
      protocolVersion: '1',
    },
    fetchImplementation,
  );
}

const pageTarget: OcrTarget = {
  targetId: 'page-2',
  kind: 'PAGE',
  pageNo: 2,
  slideNo: null,
  sheetName: null,
  bbox: null,
  assetRef: null,
  reason: 'IMAGE_ONLY',
};

const validOcrResult: OcrResult = {
  engine: 'paddleocr',
  engineRevision: '2026.08',
  protocolVersion: '2',
  results: [
    {
      targetId: 'page-2',
      pageNo: 2,
      averageConfidence: 0.9,
      blocks: [
        {
          type: 'PARAGRAPH',
          text: 'OCR 正文',
          originalText: 'OCR 正文',
          pageNo: 2,
          sheetName: null,
          slideNo: null,
          bbox: null,
          headingLevel: null,
          confidence: 0.9,
          table: null,
          metadata: {},
        },
      ],
    },
  ],
  durationMs: 8,
  warnings: [],
};

function ocrAdapter(fetchImplementation: typeof fetch): HttpOcrAdapter {
  return new HttpOcrAdapter(
    {
      baseUrl: 'http://ocr.test/',
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
      maxAttempts: 2,
      profileId: 'ocr-v1',
      modelId: 'paddleocr',
      revision: '2026.08',
      protocolVersion: '2',
    },
    fetchImplementation,
  );
}

describe('文件解析与OCR provider adapters', () => {
  it('[PAR-002] 内置扫描能跨 chunk 命中 EICAR，并拒绝可执行文件魔数', async () => {
    const scanner = new BuiltinContentSafetyScannerAdapter({
      profileId: 'builtin-test',
      revision: '1.0.0',
      maxBytes: 1_024,
      timeoutMs: 1_000,
    });
    const eicar = new TextEncoder().encode(
      ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''),
    );
    const eicarResult = await scanner.scan(
      (async function* () {
        yield eicar.slice(0, 20);
        yield eicar.slice(20);
        // 命中后仍必须把共享观察流消费到底，否则下游 Hash/魔数观察器无法完成确定性校验。
        yield Uint8Array.of(0x00, 0x01, 0x02);
      })(),
      new AbortController().signal,
    );
    expect(eicarResult).toMatchObject({
      verdict: 'INFECTED',
      signatureName: 'BUILTIN_EICAR_TEST_FILE',
      scannedBytes: eicar.byteLength + 3,
    });

    const executableResult = await scanner.scan(
      (async function* () {
        yield Uint8Array.of(0x4d, 0x5a, 0x90, 0x00);
      })(),
      new AbortController().signal,
    );
    expect(executableResult).toMatchObject({
      verdict: 'INFECTED',
      signatureName: 'BUILTIN_EXECUTABLE_PE',
    });
  });

  it('[PAR-005] 标准 HTTP Parser 成功响应必须通过运行时 Schema 和协议版本', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(validResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(adapter(fetchMock).parse(source, new AbortController().signal)).resolves.toEqual(
      validResult,
    );
  });

  it('[PAR-013] 429 有限重试后成功，避免无限重试风暴', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validResult), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(adapter(fetchMock).parse(source, new AbortController().signal)).resolves.toEqual(
      validResult,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('[PAR-024] Parser 的稳定文档错误码穿过 HTTP Adapter，不能退化成通用 422', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: 'public-request-id',
          code: 'IMAGE_ANIMATION_UNSUPPORTED',
          message: '当前版本不解析动画图片',
          retryable: false,
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      adapter(fetchMock).parse(source, new AbortController().signal),
    ).rejects.toMatchObject<Partial<ProcessingProviderError>>({
      failureClass: 'DOCUMENT_PROBLEM',
      code: 'IMAGE_ANIMATION_UNSUPPORTED',
    });
  });

  it('[PAR-005][PAR-013] 缺字段和协议版本漂移归为开发缺陷', async () => {
    const schemaFetch = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      adapter(schemaFetch).parse(source, new AbortController().signal),
    ).rejects.toMatchObject<Partial<ProcessingProviderError>>({
      failureClass: 'DEVELOPER_DEFECT',
      code: 'PARSER_SCHEMA_MISMATCH',
    });

    const versionFetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...validResult, protocolVersion: '2' }), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(
      adapter(versionFetch).parse(source, new AbortController().signal),
    ).rejects.toMatchObject<Partial<ProcessingProviderError>>({
      failureClass: 'DEVELOPER_DEFECT',
      code: 'PARSER_PROTOCOL_VERSION_MISMATCH',
    });
  });

  it('[PAR-016] OCR 缺失目标必须显式标记，不能伪装成完整成功', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...validOcrResult, results: [] }), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(
      ocrAdapter(fetchMock).recognize(source, [pageTarget], new AbortController().signal),
    ).resolves.toMatchObject({ results: [], warnings: ['OCR_TARGET_RESULT_MISSING'] });
  });

  it('[PAR-016] OCR 重复、额外和错误页码结果必须以稳定契约错误拒绝', async () => {
    const duplicateRequestFetch = jest.fn() as unknown as typeof fetch;
    await expect(
      ocrAdapter(duplicateRequestFetch).recognize(
        source,
        [pageTarget, pageTarget],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject<Partial<ProcessingProviderError>>({
      code: 'OCR_DUPLICATE_REQUEST_TARGET',
    });
    expect(duplicateRequestFetch).not.toHaveBeenCalled();

    const cases = [
      {
        result: {
          ...validOcrResult,
          results: [validOcrResult.results[0], validOcrResult.results[0]],
        },
        code: 'OCR_DUPLICATE_TARGET_RESULT',
      },
      {
        result: {
          ...validOcrResult,
          results: [{ ...validOcrResult.results[0], targetId: 'page-999', pageNo: 999 }],
        },
        code: 'OCR_UNREQUESTED_TARGET',
      },
      {
        result: {
          ...validOcrResult,
          results: [{ ...validOcrResult.results[0], pageNo: 3 }],
        },
        code: 'OCR_TARGET_LOCATION_MISMATCH',
      },
    ];
    for (const testCase of cases) {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(testCase.result), { status: 200 }),
        ) as unknown as typeof fetch;
      await expect(
        ocrAdapter(fetchMock).recognize(source, [pageTarget], new AbortController().signal),
      ).rejects.toMatchObject<Partial<ProcessingProviderError>>({ code: testCase.code });
    }
  });

  it('[PAR-016] OCR Block 定位必须与目标一致，缺少的 Slide/Sheet 定位由 Adapter 补齐', async () => {
    const slideTarget: OcrTarget = {
      targetId: 'pptx-slide-4-image-1',
      kind: 'EMBEDDED_IMAGE',
      pageNo: 4,
      slideNo: 4,
      sheetName: null,
      bbox: null,
      assetRef: null,
      reason: 'EMBEDDED_SCREENSHOT',
    };
    const response = {
      ...validOcrResult,
      results: [
        {
          ...validOcrResult.results[0],
          targetId: slideTarget.targetId,
          pageNo: 4,
          blocks: [
            {
              ...validOcrResult.results[0]!.blocks[0],
              pageNo: 4,
              slideNo: null,
            },
          ],
        },
      ],
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      ) as unknown as typeof fetch;
    const result = await ocrAdapter(fetchMock).recognize(
      source,
      [slideTarget],
      new AbortController().signal,
    );
    expect(result.results[0]?.blocks[0]).toMatchObject({
      pageNo: 4,
      slideNo: 4,
      metadata: { extractionSource: 'OCR', sourceTargetId: slideTarget.targetId },
    });
  });

  it('[PAR-016][PAR-013] OCR 429 有限重试，调用方取消后不再重试', async () => {
    const retryFetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(validOcrResult), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(
      ocrAdapter(retryFetch).recognize(source, [pageTarget], new AbortController().signal),
    ).resolves.toMatchObject({ engine: 'paddleocr' });
    expect(retryFetch).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const cancellation = new Error('cancelled-by-caller');
    controller.abort(cancellation);
    const cancelledFetch = jest.fn().mockRejectedValue(cancellation) as unknown as typeof fetch;
    await expect(
      ocrAdapter(cancelledFetch).recognize(source, [pageTarget], controller.signal),
    ).rejects.toBe(cancellation);
    expect(cancelledFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['text', 'OCR 纯文本', 'OCR 纯文本'],
    ['json-string', JSON.stringify('JSON 字符串正文'), 'JSON 字符串正文'],
    ['json-text-field', JSON.stringify({ text: 'JSON 字段正文' }), 'JSON 字段正文'],
  ] as const)(
    '[OPT-010] %s 响应只映射单一目标且未知质量保持 null',
    async (format, body, expected) => {
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'content-type': format === 'text' ? 'text/plain' : 'application/json' },
        }),
      ) as unknown as typeof fetch;
      const plainAdapter = new HttpOcrAdapter(
        {
          baseUrl: 'http://ocr.test/',
          timeoutMs: 1_000,
          maxResponseBytes: 10_000,
          maxAttempts: 2,
          profileId: 'ocr-plain-v1',
          modelId: 'paddleocr',
          revision: '2026.08',
          protocolVersion: '2',
          responseFormat: format,
          jsonTextField: 'text',
        },
        fetchMock,
      );
      const result = await plainAdapter.recognize(
        source,
        [pageTarget],
        new AbortController().signal,
      );
      expect(result.results[0]).toMatchObject({
        targetId: pageTarget.targetId,
        pageNo: pageTarget.pageNo,
        averageConfidence: null,
        blocks: [{ text: expected, confidence: null, bbox: null }],
      });
      expect(result.warnings).toEqual(
        expect.arrayContaining(['OCR_CONFIDENCE_UNAVAILABLE', 'OCR_FINE_LOCATION_UNAVAILABLE']),
      );
    },
  );

  it('[OPT-010] 纯文本多目标与 HTML 错误页必须在边界拒绝，不能复制或入库', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response('<html>upstream failed</html>', { status: 200 }),
      ) as unknown as typeof fetch;
    const plainAdapter = new HttpOcrAdapter(
      {
        baseUrl: 'http://ocr.test/',
        timeoutMs: 1_000,
        maxResponseBytes: 10_000,
        profileId: 'ocr-plain-v1',
        modelId: 'paddleocr',
        revision: '2026.08',
        protocolVersion: '2',
        responseFormat: 'text',
      },
      fetchMock,
    );
    await expect(
      plainAdapter.recognize(
        source,
        [pageTarget, { ...pageTarget, targetId: 'page-3', pageNo: 3 }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'OCR_PLAIN_TEXT_MULTI_TARGET_UNSUPPORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      plainAdapter.recognize(source, [pageTarget], new AbortController().signal),
    ).rejects.toMatchObject({ code: 'OCR_HTML_ERROR_RESPONSE' });
  });
});
