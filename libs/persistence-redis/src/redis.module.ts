/** Redis Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { AUTHORIZATION_CACHE } from '@rag/application';
import { RedisAuthorizationCacheAdapter } from './redis-authorization-cache.adapter';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from './redis-health.probe';

/** 当前注册在线与离线两套 Redis 探针。 */
@Module({
  providers: [
    RedisCacheHealthProbe,
    RedisBullmqHealthProbe,
    RedisAuthorizationCacheAdapter,
    { provide: AUTHORIZATION_CACHE, useExisting: RedisAuthorizationCacheAdapter },
  ],
  exports: [RedisCacheHealthProbe, RedisBullmqHealthProbe, AUTHORIZATION_CACHE],
})
export class RedisPersistenceModule {}
