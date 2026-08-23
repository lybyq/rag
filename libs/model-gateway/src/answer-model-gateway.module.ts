/**
 * 结构化答案模型 Composition Root。
 *
 * 外网 DeepSeek、测试 Fixture 与内网 HTTP Gateway 都实现同一个 AnswerModelPort，业务图不读取
 * Provider 配置。
 *
 * @requirement ANS-009
 * @requirement ANS-013
 * @requirement CFG-001
 */
import { Module } from '@nestjs/common';
import { ANSWER_MODEL_PORT, type AnswerModelPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { FixtureAnswerModelAdapter, HttpAnswerModelAdapter } from './answer-model.adapter';

/** 答案模型网关模块。 */
@Module({
  providers: [
    {
      provide: ANSWER_MODEL_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AnswerModelPort =>
        config.llm.adapter === 'fixture'
          ? new FixtureAnswerModelAdapter(config)
          : new HttpAnswerModelAdapter(config),
    },
  ],
  exports: [ANSWER_MODEL_PORT],
})
export class AnswerModelGatewayModule {}
