/** 文件解析与OCR 管理查询 Composition Root；不在 API 进程执行实际文件解析。 */
import { Module } from '@nestjs/common';
import {
  DOCUMENT_OCR,
  DOCUMENT_PARSER,
  DOCUMENT_PROCESSING_REPOSITORY,
  DocumentProcessingAdminService,
  MALWARE_SCANNER,
  type DocumentProcessingRepository,
  type MalwareScannerPort,
  type OcrPort,
  type ParserPort,
} from '@rag/application';
import { FileProcessingProvidersModule } from '@rag/file-processing-providers';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import {
  DocumentVersionParseRunsController,
  ParseRunsController,
  ParsingProfilesController,
} from './parsing.controller';

@Module({
  imports: [IdentityAccessModule, PostgresPersistenceModule, FileProcessingProvidersModule],
  controllers: [DocumentVersionParseRunsController, ParseRunsController, ParsingProfilesController],
  providers: [
    {
      provide: DocumentProcessingAdminService,
      inject: [DOCUMENT_PROCESSING_REPOSITORY, MALWARE_SCANNER, DOCUMENT_PARSER, DOCUMENT_OCR],
      useFactory: (
        repository: DocumentProcessingRepository,
        scanner: MalwareScannerPort,
        parser: ParserPort,
        ocr: OcrPort,
      ): DocumentProcessingAdminService =>
        new DocumentProcessingAdminService(repository, scanner, parser, ocr),
    },
  ],
})
export class DocumentParsingModule {}
