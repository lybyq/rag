/** Redis Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { AUTHORIZATION_CACHE, INGESTION_EVENT_PUBLISHER } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { BullmqIngestionEventPublisher } from './bullmq-ingestion-event.publisher';
import { RedisAuthorizationCacheAdapter } from './redis-authorization-cache.adapter';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from './redis-health.probe';

/** 当前注册在线与离线两套 Redis 探针。 */
@Module({
  providers: [
    RedisCacheHealthProbe,
    RedisBullmqHealthProbe,
    RedisAuthorizationCacheAdapter,
    { provide: AUTHORIZATION_CACHE, useExisting: RedisAuthorizationCacheAdapter },
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
    INGESTION_EVENT_PUBLISHER,
  ],
})
export class RedisPersistenceModule {}
