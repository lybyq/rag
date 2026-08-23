/**
 * 证据、生成与答案校验 Composition Root 冒烟门禁。
 *
 * 编译真实 Query Service 模块，验证检索子图、Reranker、答案模型、证据 Repository、生命周期、
 * Telemetry 和执行器能被 NestJS 完整解析；不触发模块生命周期，因此不会领取真实 Run。
 *
 * @requirement ANS-001
 * @requirement ANS-015
 */
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AnswerGenerationExecutionService } from '@rag/rag-graph';
import { RagQueryServiceModule } from '../app.module';

describe('[ANS-001][ANS-015] 答案生成 Composition Root', () => {
  let module: TestingModule | undefined;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [RagQueryServiceModule] }).compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('真实模块图可以解析答案执行器', () => {
    expect(module?.get(AnswerGenerationExecutionService)).toBeInstanceOf(
      AnswerGenerationExecutionService,
    );
  });
});
