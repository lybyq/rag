/**
 * 独立 Node Parser Service 的 NestJS 组合根。
 * 这里只把受控配置、可观测性、下载器和全格式 Registry 连接起来，不接入 PG/Redis/Milvus/模型。
 *
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-006
 */
import { Module } from '@nestjs/common';
import { APP_CONFIG, RuntimeConfigModule, type AppConfig } from '@rag/config';
import { createDocumentParserRegistry, type ParserRegistry } from '@rag/document-parser-core';
import { ObservabilityModule } from '@rag/observability';
import { ParserHealthController } from './health.controller';
import { ParserController } from './parser.controller';
import { ParserSourceLoader } from './source-loader.service';
import { DOCUMENT_PARSER_REGISTRY } from './tokens';

/** Parser Service 根模块。 */
@Module({
  imports: [RuntimeConfigModule, ObservabilityModule],
  controllers: [ParserController, ParserHealthController],
  providers: [
    ParserSourceLoader,
    {
      provide: DOCUMENT_PARSER_REGISTRY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ParserRegistry =>
        createDocumentParserRegistry(
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
        ),
    },
  ],
})
export class DocumentParserServiceModule {}
