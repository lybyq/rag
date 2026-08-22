/** M06 Redis Stream 与取消广播的独立 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { RAG_RUN_CANCELLATION, RAG_RUN_EVENT_STREAM } from '@rag/application';
import { RedisRagRunEventStreamAdapter } from './redis-rag-run-event-stream.adapter';

/** 仅由 rag-query-service 引入，避免管理面无故创建 Stream 订阅连接。 */
@Module({
  providers: [
    RedisRagRunEventStreamAdapter,
    { provide: RAG_RUN_EVENT_STREAM, useExisting: RedisRagRunEventStreamAdapter },
    { provide: RAG_RUN_CANCELLATION, useExisting: RedisRagRunEventStreamAdapter },
  ],
  exports: [RAG_RUN_EVENT_STREAM, RAG_RUN_CANCELLATION],
})
export class RagRunRedisModule {}
