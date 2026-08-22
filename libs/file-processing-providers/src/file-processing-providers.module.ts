/** M03 Provider Adapter 的配置化 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import {
  DOCUMENT_OCR,
  DOCUMENT_PARSER,
  MALWARE_SCANNER,
  type MalwareScannerPort,
  type OcrPort,
  type ParserPort,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { BuiltinContentSafetyScannerAdapter } from './builtin-content-safety-scanner.adapter';
import { DoclingOcrAdapter, DoclingParserAdapter } from './docling.adapter';
import {
  FixtureMalwareScannerAdapter,
  FixtureOcrAdapter,
  FixtureParserAdapter,
} from './fixture.adapters';
import { HttpOcrAdapter } from './http-ocr.adapter';
import { HttpParserAdapter } from './http-parser.adapter';

@Module({
  providers: [
    {
      provide: MALWARE_SCANNER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MalwareScannerPort =>
        config.fileProcessing.scanner.adapter === 'builtin'
          ? new BuiltinContentSafetyScannerAdapter({
              ...config.fileProcessing.scanner,
              maxBytes: config.upload.maxFileBytes,
            })
          : new FixtureMalwareScannerAdapter(
              config.fileProcessing.scanner.profileId,
              config.fileProcessing.scanner.revision,
              config.fileProcessing.scanner.timeoutMs,
            ),
    },
    {
      provide: DOCUMENT_PARSER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ParserPort => {
        const parser = config.fileProcessing.parser;
        const common = { ...parser, maxAttempts: 3 };
        if (parser.adapter === 'docling') return new DoclingParserAdapter(common);
        if (parser.adapter === 'http') return new HttpParserAdapter(common);
        return new FixtureParserAdapter(
          parser.profileId,
          parser.revision,
          parser.protocolVersion,
          parser.timeoutMs,
        );
      },
    },
    {
      provide: DOCUMENT_OCR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): OcrPort => {
        const ocr = config.fileProcessing.ocr;
        const common = {
          ...ocr,
          maxResponseBytes: config.fileProcessing.parser.maxResponseBytes,
          maxAttempts: 3,
        };
        if (ocr.adapter === 'docling') return new DoclingOcrAdapter(common);
        if (ocr.adapter === 'http') return new HttpOcrAdapter(common);
        return new FixtureOcrAdapter(
          ocr.profileId,
          ocr.revision,
          ocr.protocolVersion,
          ocr.timeoutMs,
        );
      },
    },
  ],
  exports: [MALWARE_SCANNER, DOCUMENT_PARSER, DOCUMENT_OCR],
})
export class FileProcessingProvidersModule {}
