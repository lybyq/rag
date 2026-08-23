/** Redis Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import {
  AUTHORIZATION_CACHE,
  INGESTION_EVENT_PUBLISHER,
  RETRIEVAL_CACHE_PORT,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { BullmqIngestionEventPublisher } from './bullmq-ingestion-event.publisher';
import { RedisAuthorizationCacheAdapter } from './redis-authorization-cache.adapter';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from './redis-health.probe';
import { RedisRetrievalCacheAdapter } from './redis-retrieval-cache.adapter';

/** 当前注册在线与离线两套 Redis 探针。 */
@Module({
  providers: [
    RedisCacheHealthProbe,
    RedisBullmqHealthProbe,
    RedisAuthorizationCacheAdapter,
    RedisRetrievalCacheAdapter,
    { provide: AUTHORIZATION_CACHE, useExisting: RedisAuthorizationCacheAdapter },
    { provide: RETRIEVAL_CACHE_PORT, useExisting: RedisRetrievalCacheAdapter },
    {
      provide: INGESTION_EVENT_PUBLISHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): BullmqIngestionEventPublisher =>
        new BullmqIngestionEventPublisher(config),
    },
  ],
  exports: [
    RedisCacheHealthProbe,
    RedisBullmqHealthProbe,
    AUTHORIZATION_CACHE,
    RETRIEVAL_CACHE_PORT,
    INGESTION_EVENT_PUBLISHER,
  ],
})
export class RedisPersistenceModule {}
