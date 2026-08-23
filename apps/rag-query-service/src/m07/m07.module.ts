/**
 * M07 查询规划与混合检索 Composition Root。
 *
 * 本模块在 M06 Run 底座之上组装 LangGraph、LLM 改写、查询 Embedding、Redis 缓存、
 * Milvus Dense/Sparse 和 PostgreSQL 回源；环境差异只在各 Adapter 模块读取配置。
 *
 * @requirement RET-001
 * @requirement RET-008
 * @requirement RET-009
 * @requirement RET-016
 */
import { Module } from '@nestjs/common';
import {
  EMBEDDING_PORT,
  QUERY_REWRITE_PORT,
  RAG_RUN_CANCELLATION,
  RETRIEVAL_CACHE_PORT,
  RETRIEVAL_SOURCE_REPOSITORY,
  RETRIEVAL_TELEMETRY,
  SENSITIVE_TEXT_PROTECTOR,
  AuthorizationService,
  type EmbeddingPort,
  type QueryRewritePort,
  type RagRunCancellationPort,
  type RetrievalCachePort,
  type RetrievalSourceRepository,
  type RetrievalTelemetryPort,
  type SensitiveTextProtectorPort,
  type VectorIndexPort,
  VECTOR_INDEX_PORT,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { EmbeddingGatewayModule, QueryRewriteGatewayModule } from '@rag/model-gateway';
import { MilvusPersistenceModule } from '@rag/persistence-milvus';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { M07RetrievalService } from '@rag/rag-graph';
import { M06Module } from '../m06/m06.module';
import { M07TelemetryAdapter } from './m07-telemetry.adapter';
import { RetrievalDebugController } from './retrieval-debug.controller';

/** M07 Query Service 模块。 */
@Module({
  imports: [
    M06Module,
    PostgresPersistenceModule,
    RedisPersistenceModule,
    MilvusPersistenceModule,
    EmbeddingGatewayModule,
    QueryRewriteGatewayModule,
  ],
  controllers: [RetrievalDebugController],
  providers: [
    M07TelemetryAdapter,
    { provide: RETRIEVAL_TELEMETRY, useExisting: M07TelemetryAdapter },
    {
      provide: M07RetrievalService,
      inject: [
        QUERY_REWRITE_PORT,
        EMBEDDING_PORT,
        VECTOR_INDEX_PORT,
        RETRIEVAL_CACHE_PORT,
        RETRIEVAL_SOURCE_REPOSITORY,
        RETRIEVAL_TELEMETRY,
        APP_CONFIG,
        AuthorizationService,
        SENSITIVE_TEXT_PROTECTOR,
        RAG_RUN_CANCELLATION,
      ],
      useFactory: (
        rewrite: QueryRewritePort,
        embedding: EmbeddingPort,
        vectorIndex: VectorIndexPort,
        cache: RetrievalCachePort,
        source: RetrievalSourceRepository,
        telemetry: RetrievalTelemetryPort,
        config: AppConfig,
        authorization: AuthorizationService,
        protector: SensitiveTextProtectorPort,
        cancellation: RagRunCancellationPort,
      ): M07RetrievalService =>
        new M07RetrievalService(
          {
            rewrite,
            embedding,
            vectorIndex,
            cache,
            source,
            telemetry,
            embeddingRequestTimeoutMs: config.embedding.requestTimeoutMs,
            vectorRequestTimeoutMs: config.milvus.requestTimeoutMs,
            llmRequestTimeoutMs: config.llm.requestTimeoutMs,
            embeddingMaxInputTokens: config.embedding.maxInputTokens,
            queryCacheTtlSeconds: config.retrieval.queryCacheTtlSeconds,
            expectedEmbeddingRevision: config.embedding.revision,
            expectedEmbeddingModelId: config.embedding.modelId,
            expectedEmbeddingDimension: config.embedding.denseDimension,
          },
          source,
          authorization,
          protector,
          cancellation,
        ),
    },
  ],
  exports: [M07RetrievalService],
})
export class M07Module {}
