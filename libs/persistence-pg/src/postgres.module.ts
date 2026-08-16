/** PostgreSQL Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { PostgresHealthProbe } from './postgres-health.probe';

/** 当前只注册 M00 所需的健康探针，业务 Repository 在后续模块加入。 */
@Module({ providers: [PostgresHealthProbe], exports: [PostgresHealthProbe] })
export class PostgresPersistenceModule {}
