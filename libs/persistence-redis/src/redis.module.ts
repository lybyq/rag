/** Redis Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import {
  AUTHORIZATION_CACHE,
  INGESTION_EVENT_PUBLISHER,
  RETRIEVAL_CACHE_PORT,
  TRAFFIC_CONTROL,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { BullmqIngestionEventPublisher } from './bullmq-ingestion-event.publisher';
import { RedisAuthorizationCacheAdapter } from './redis-authorization-cache.adapter';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from './redis-health.probe';
import { RedisRetrievalCacheAdapter } from './redis-retrieval-cache.adapter';
import { RedisTrafficControlAdapter } from './redis-traffic-control.adapter';

/** 当前注册在线与离线两套 Redis 探针。 */
@Module({
  providers: [
    RedisCacheHealthProbe,
    RedisBullmqHealthProbe,
    RedisAuthorizationCacheAdapter,
    RedisRetrievalCacheAdapter,
    RedisTrafficControlAdapter,
    { provide: AUTHORIZATION_CACHE, useExisting: RedisAuthorizationCacheAdapter },
    { provide: RETRIEVAL_CACHE_PORT, useExisting: RedisRetrievalCacheAdapter },
    { provide: TRAFFIC_CONTROL, useExisting: RedisTrafficControlAdapter },
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
    TRAFFIC_CONTROL,
    INGESTION_EVENT_PUBLISHER,
  ],
})
export class RedisPersistenceModule {}
