/** 使用真实 Nest 模块装配验证依赖注入、路由和请求上下文可以共同启动。 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PlatformApiModule } from './app.module';

describe('Platform API M00 smoke', () => {
  let application: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PlatformApiModule] }).compile();
    application = module.createNestApplication();
    application.setGlobalPrefix('api/v1');
    await application.init();
  });

  afterAll(async () => {
    await application.close();
  });

  it('liveness 回传客户端合法 Request ID 且不访问外部依赖', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-request-id', 'm00-smoke-request-0001')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('m00-smoke-request-0001');
    expect(response.body).toEqual(
      expect.objectContaining({
        requestId: 'm00-smoke-request-0001',
        data: expect.objectContaining({ service: 'rag-service', status: 'up', dependencies: [] }),
      }),
    );
  });

  it('metrics 使用 Prometheus Content-Type', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/v1/metrics')
      .expect('Content-Type', /text\/plain/)
      .expect(200);

    expect(response.text).toContain('rag_http_request_duration_seconds');
  });
});
