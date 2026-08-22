/** 文档接入 Worker 根模块；M02 起注册 BullMQ 消费者和接入状态机。 */
import { Module } from '@nestjs/common';
import {
  DOCUMENT_OCR,
  DOCUMENT_PARSER,
  DOCUMENT_PROCESSING_REPOSITORY,
  DocumentProcessingService,
  KNOWLEDGE_PROCESSING_REPOSITORY,
  KnowledgeProcessingService,
  MALWARE_SCANNER,
  OBJECT_STORAGE,
  type DocumentProcessingRepository,
  type MalwareScannerPort,
  type ObjectStoragePort,
  type OcrPort,
  type ParserPort,
  type KnowledgeProcessingRepository,
} from '@rag/application';
import { Cl100kTextTokenizer } from '@rag/chunking';
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
          providerProfile: config.providerProfile,
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
    {
      provide: KnowledgeProcessingService,
      inject: [KNOWLEDGE_PROCESSING_REPOSITORY, APP_CONFIG],
      useFactory: (
        repository: KnowledgeProcessingRepository,
        config: AppConfig,
      ): KnowledgeProcessingService => {
        if (config.knowledgeProcessing.tokenizerAdapter !== 'cl100k') {
          throw new Error('当前构建只支持 cl100k Tokenizer Adapter');
        }
        const tokenizer = new Cl100kTextTokenizer(config.knowledgeProcessing.tokenizerProfileId);
        return new KnowledgeProcessingService(repository, tokenizer, {
          providerProfile: config.providerProfile,
          chunkerProfileId: config.knowledgeProcessing.chunkerProfileId,
          chunkerRevision: config.knowledgeProcessing.chunkerRevision,
          qualityRuleVersion: config.knowledgeProcessing.qualityRuleVersion,
          chunking: {
            childMaxTokens: config.knowledgeProcessing.childMaxTokens,
            parentMaxTokens: config.knowledgeProcessing.parentMaxTokens,
            overlapTokens: config.knowledgeProcessing.overlapTokens,
            dedupMode: config.knowledgeProcessing.dedupMode,
          },
          quality: {
            minimumNonEmptyBlockRatio: config.knowledgeProcessing.minimumNonEmptyBlockRatio,
            rejectNonEmptyBlockRatio: config.knowledgeProcessing.rejectNonEmptyBlockRatio,
            minimumOcrConfidence: config.knowledgeProcessing.minimumOcrConfidence,
            maximumGarbledRatio: config.knowledgeProcessing.maximumGarbledRatio,
            rejectGarbledRatio: config.knowledgeProcessing.rejectGarbledRatio,
            maximumDuplicateRatio: config.knowledgeProcessing.maximumDuplicateRatio,
            requireHeadingAfterBlocks: config.knowledgeProcessing.requireHeadingAfterBlocks,
          },
        });
      },
    },
    IngestionQueueConsumer,
  ],
})
export class IngestionWorkerModule {}
