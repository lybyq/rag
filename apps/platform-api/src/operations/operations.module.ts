/**
 * 运维控制面的 NestJS Composition Root。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement OPS-018
 */
import { Module } from '@nestjs/common';
import {
  OPERATIONS_REPOSITORY,
  OperationsService,
  PROVIDER_OPERATIONS,
  RUNTIME_OPERATIONS,
  type OperationsRepository,
  type ProviderOperationsPort,
  type RuntimeOperationsPort,
} from '@rag/application';
import { HealthModule } from '@rag/health';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import { OperationsController, PlatformOverviewController } from './operations.controller';
import { PlatformRuntimeOperationsAdapter } from './platform-runtime-operations.adapter';

@Module({
  imports: [IdentityAccessModule, PostgresPersistenceModule, HealthModule],
  controllers: [PlatformOverviewController, OperationsController],
  providers: [
    PlatformRuntimeOperationsAdapter,
    { provide: RUNTIME_OPERATIONS, useExisting: PlatformRuntimeOperationsAdapter },
    { provide: PROVIDER_OPERATIONS, useExisting: PlatformRuntimeOperationsAdapter },
    {
      provide: OperationsService,
      inject: [OPERATIONS_REPOSITORY, RUNTIME_OPERATIONS, PROVIDER_OPERATIONS],
      useFactory: (
        repository: OperationsRepository,
        runtime: RuntimeOperationsPort,
        providers: ProviderOperationsPort,
      ): OperationsService => new OperationsService(repository, runtime, providers),
    },
  ],
})
export class OperationsModule {}
