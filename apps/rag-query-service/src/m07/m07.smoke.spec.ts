/**
 * M07 Composition Root 冒烟门禁。
 *
 * 只编译真实 RagQueryServiceModule，验证 LangGraph 服务、模型/存储 Port、Telemetry 与 M06 授权依赖
 * 能被 NestJS 完整解析。这里不初始化 HTTP 生命周期，避免单元测试隐式连接真实内网 Provider。
 *
 * @requirement RET-016
 */
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { M07RetrievalService } from '@rag/rag-graph';
import { RagQueryServiceModule } from '../app.module';

describe('[RET-016] M07 Composition Root', () => {
  let module: TestingModule | undefined;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [RagQueryServiceModule] }).compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  test('真实模块图可以解析 M07RetrievalService', () => {
    expect(module?.get(M07RetrievalService)).toBeInstanceOf(M07RetrievalService);
  });
});
