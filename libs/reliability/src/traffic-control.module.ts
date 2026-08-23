/** 在线流控的 NestJS 组装模块。 @requirement OPS-007 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { TrafficControlInterceptor } from './traffic-control.interceptor';

/** 注册全局在线 Run 拦截器；认证 Guard 会先建立可信身份。 */
@Module({
  imports: [RedisPersistenceModule],
  providers: [
    TrafficControlInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: TrafficControlInterceptor },
  ],
})
export class TrafficControlModule {}
