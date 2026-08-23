/**
 * Reranker Provider Composition Root。
 *
 * 只有本模块读取 `RERANKER_ADAPTER`；证据图永远只注入 RerankerPort。
 *
 * @requirement ANS-002
 * @requirement CFG-001
 */
import { Module } from '@nestjs/common';
import { RERANKER_PORT, type RerankerPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { FixtureRerankerAdapter, HttpRerankerAdapter } from './reranker.adapter';

/** Reranker 网关模块。 */
@Module({
  providers: [
    {
      provide: RERANKER_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RerankerPort =>
        config.reranker.adapter === 'fixture'
          ? new FixtureRerankerAdapter(config)
          : new HttpRerankerAdapter(config),
    },
  ],
  exports: [RERANKER_PORT],
})
export class RerankerGatewayModule {}
