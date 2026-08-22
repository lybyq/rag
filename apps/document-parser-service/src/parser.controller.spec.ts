/**
 * 独立 Parser HTTP 协议测试：覆盖 Schema、协议版本、共享密钥、SSRF 白名单和真实 Registry 输出。
 * 测试不访问公网或 MinIO，源文件字节由合成 Fixture 注入。
 *
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-013
 */
import { loadAppConfig } from '@rag/config';
import { createDocumentParserRegistry } from '@rag/document-parser-core';
import { MetricsService } from '@rag/observability';
import type { Request } from 'express';
import { EventEmitter } from 'node:events';
import { ParserController } from './parser.controller';
import { ParserSourceLoader } from './source-loader.service';

const config = loadAppConfig({
  APP_ENV: 'development',
  PROVIDER_PROFILE: 'external-dev',
  PARSER_API_KEY: 'parser-test-secret',
  PARSER_ALLOWED_SOURCE_HOSTS: 'minio,localhost,127.0.0.1',
});

describe('[PAR-004][PAR-005] document parser HTTP protocol', () => {
  let metrics: MetricsService;

  afterEach(() => metrics?.onModuleDestroy());

  it('合法请求返回与配置 revision/protocol 完全一致的 ParserResult', async () => {
    metrics = new MetricsService();
    const registry = createDocumentParserRegistry(
      {
        ...config.fileProcessing.limits,
        maxInputBytes: config.fileProcessing.parser.maxInputBytes,
        maxArchiveEntries: config.fileProcessing.parser.maxArchiveEntries,
        maxXmlEntryBytes: config.fileProcessing.parser.maxXmlEntryBytes,
      },
      {
        revision: config.fileProcessing.parser.revision,
        protocolVersion: config.fileProcessing.parser.protocolVersion,
      },
    );
    const sourceLoader = {
      load: jest.fn().mockResolvedValue(tinyPng()),
    } as unknown as ParserSourceLoader;
    const controller = new ParserController(config, registry, sourceLoader, metrics);
    const request = new EventEmitter() as unknown as Request;

    await expect(
      controller.parse(
        {
          protocolVersion: config.fileProcessing.parser.protocolVersion,
          source: {
            url: 'http://minio:9000/rag-quarantine/object?temporary=true',
            fileName: 'image.png',
            format: 'IMAGE',
            declaredMime: 'image/png',
          },
        },
        'Bearer parser-test-secret',
        request,
      ),
    ).resolves.toMatchObject({
      parserRevision: config.fileProcessing.parser.revision,
      protocolVersion: config.fileProcessing.parser.protocolVersion,
      ocrCandidates: [expect.objectContaining({ kind: 'WHOLE_IMAGE' })],
    });
  });

  it('错误密钥、协议漂移和未知字段都 fail closed', async () => {
    metrics = new MetricsService();
    const registry = createDocumentParserRegistry(
      {
        ...config.fileProcessing.limits,
        maxInputBytes: config.fileProcessing.parser.maxInputBytes,
        maxArchiveEntries: config.fileProcessing.parser.maxArchiveEntries,
        maxXmlEntryBytes: config.fileProcessing.parser.maxXmlEntryBytes,
      },
      {
        revision: config.fileProcessing.parser.revision,
        protocolVersion: config.fileProcessing.parser.protocolVersion,
      },
    );
    const sourceLoader = {
      load: jest.fn().mockResolvedValue(tinyPng()),
    } as unknown as ParserSourceLoader;
    const controller = new ParserController(config, registry, sourceLoader, metrics);
    const request = new EventEmitter() as unknown as Request;
    const source = {
      url: 'http://minio:9000/object',
      fileName: 'image.png',
      format: 'IMAGE',
      declaredMime: 'image/png',
    };

    await expect(
      controller.parse({ protocolVersion: '2', source }, 'Bearer wrong', request),
    ).rejects.toMatchObject({
      code: 'PARSER_UNAUTHORIZED',
      httpStatus: 401,
    });
    await expect(
      controller.parse({ protocolVersion: '999', source }, 'Bearer parser-test-secret', request),
    ).rejects.toMatchObject({ code: 'PARSER_PROTOCOL_VERSION_MISMATCH', httpStatus: 409 });
    await expect(
      controller.parse(
        { protocolVersion: '2', source, unexpected: true },
        'Bearer parser-test-secret',
        request,
      ),
    ).rejects.toMatchObject({ code: 'PARSER_REQUEST_SCHEMA_INVALID', httpStatus: 400 });
  });

  it('下载器在网络调用前拒绝不在白名单的源主机', async () => {
    const loader = new ParserSourceLoader(config);
    await expect(
      loader.load('https://public.example.invalid/file.pdf', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PARSER_SOURCE_HOST_FORBIDDEN' });
  });

  it('[PAR-013] 绝对 Deadline 统一映射为可重试 504', async () => {
    metrics = new MetricsService();
    const timeoutConfig = {
      ...config,
      fileProcessing: {
        ...config.fileProcessing,
        parser: { ...config.fileProcessing.parser, timeoutMs: 5 },
      },
    };
    const registry = createDocumentParserRegistry(
      {
        ...timeoutConfig.fileProcessing.limits,
        maxInputBytes: timeoutConfig.fileProcessing.parser.maxInputBytes,
        maxArchiveEntries: timeoutConfig.fileProcessing.parser.maxArchiveEntries,
        maxXmlEntryBytes: timeoutConfig.fileProcessing.parser.maxXmlEntryBytes,
      },
      {
        revision: timeoutConfig.fileProcessing.parser.revision,
        protocolVersion: timeoutConfig.fileProcessing.parser.protocolVersion,
      },
    );
    const sourceLoader = {
      load: jest.fn().mockImplementation(
        (_url: string, signal: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    } as unknown as ParserSourceLoader;
    const controller = new ParserController(timeoutConfig, registry, sourceLoader, metrics);

    await expect(
      controller.parse(
        {
          protocolVersion: timeoutConfig.fileProcessing.parser.protocolVersion,
          source: {
            url: 'http://minio:9000/object',
            fileName: 'image.png',
            format: 'IMAGE',
            declaredMime: 'image/png',
          },
        },
        'Bearer parser-test-secret',
        new EventEmitter() as unknown as Request,
      ),
    ).rejects.toMatchObject({
      code: 'PARSER_TIMEOUT',
      failureClass: 'RETRYABLE_PROVIDER',
      httpStatus: 504,
      retryable: true,
    });
  });
});

/** 1×1 合成 PNG。 */
function tinyPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}
