/**
 * 查询规划与混合检索 Composition Root 冒烟门禁。
 *
 * 只编译真实 RagQueryServiceModule，验证 LangGraph 服务、模型/存储 Port、Telemetry 与 会话运行与事件 授权依赖
 * 能被 NestJS 完整解析。这里不初始化 HTTP 生命周期，避免单元测试隐式连接真实内网 Provider。
 *
 * @requirement RET-016
 */
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { HybridRetrievalService } from '@rag/rag-graph';
import { RagQueryServiceModule } from '../app.module';

describe('[RET-016] 查询规划与混合检索 Composition Root', () => {
  let module: TestingModule | undefined;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [RagQueryServiceModule] }).compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  test('真实模块图可以解析 HybridRetrievalService', () => {
    expect(module?.get(HybridRetrievalService)).toBeInstanceOf(HybridRetrievalService);
  });
});
