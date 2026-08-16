/** Redis Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from './redis-health.probe';

/** 当前注册在线与离线两套 Redis 探针。 */
@Module({
  providers: [RedisCacheHealthProbe, RedisBullmqHealthProbe],
  exports: [RedisCacheHealthProbe, RedisBullmqHealthProbe],
})
export class RedisPersistenceModule {}
