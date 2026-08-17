/** 文档接入 Worker 根模块；M02 起注册 BullMQ 消费者和接入状态机。 */
import { Module } from '@nestjs/common';
import {
  DOCUMENT_OCR,
  DOCUMENT_PARSER,
  DOCUMENT_PROCESSING_REPOSITORY,
  DocumentProcessingService,
  MALWARE_SCANNER,
  OBJECT_STORAGE,
  type DocumentProcessingRepository,
  type MalwareScannerPort,
  type ObjectStoragePort,
  type OcrPort,
  type ParserPort,
} from '@rag/application';
import { APP_CONFIG, RuntimeConfigModule, type AppConfig } from '@rag/config';
import { FileProcessingProvidersModule } from '@rag/file-processing-providers';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { MinioPersistenceModule } from '@rag/persistence-minio';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { IngestionQueueConsumer } from './ingestion-queue.consumer';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    PostgresPersistenceModule,
    MinioPersistenceModule,
    RedisPersistenceModule,
    FileProcessingProvidersModule,
  ],
  providers: [
    {
      provide: DocumentProcessingService,
      inject: [
        DOCUMENT_PROCESSING_REPOSITORY,
        OBJECT_STORAGE,
        MALWARE_SCANNER,
        DOCUMENT_PARSER,
        DOCUMENT_OCR,
        APP_CONFIG,
      ],
      useFactory: (
        repository: DocumentProcessingRepository,
        storage: ObjectStoragePort,
        scanner: MalwareScannerPort,
        parser: ParserPort,
        ocr: OcrPort,
        config: AppConfig,
      ): DocumentProcessingService =>
        new DocumentProcessingService(repository, storage, scanner, parser, ocr, {
          derivedBucket: config.fileProcessing.derivedBucket,
          presignedGetTtlSeconds: Math.min(config.upload.presignedUrlTtlSeconds, 900),
          storageTimeoutMs: Math.max(
            config.dependencyHealthTimeoutMs * 2,
            config.fileProcessing.scanner.timeoutMs,
          ),
          objectStreamTimeoutMs: config.fileProcessing.streamTimeoutMs,
          ...config.fileProcessing.limits,
        }),
    },
    IngestionQueueConsumer,
  ],
})
export class IngestionWorkerModule {}
