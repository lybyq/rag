/** M03 Provider Port 契约测试：成功、429、Schema 漂移、版本漂移与内置流式安全扫描。 */
import type { ParserResult } from '@rag/contracts';
import { BuiltinContentSafetyScannerAdapter } from './builtin-content-safety-scanner.adapter';
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

describe('M03 provider adapters', () => {
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
});
