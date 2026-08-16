/** 使用真实 Guard、控制器和应用服务验证 M01 HTTP 信任边界。 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTHORIZATION_CACHE,
  AUTHORIZATION_VERSION_PROVIDER,
  KNOWLEDGE_SPACE_REPOSITORY,
  SECURITY_AUDIT,
  type AuthorizationCachePort,
  type KnowledgeSpaceRepository,
  type SecurityAuditPort,
} from '@rag/application';
import type { KnowledgeSpace } from '@rag/contracts';
import request from 'supertest';
import { PlatformApiModule } from '../app.module';

const createdSpace: KnowledgeSpace = {
  id: '20000000-0000-4000-8000-000000000001',
  code: 'hr-policy',
  name: '人力制度库',
  description: null,
  ownerUserId: 'dev-admin',
  status: 'ACTIVE',
  version: 1,
  policyVersion: 1,
  documentCount: 0,
  createdAt: '2026-08-16T08:00:00.000Z',
  updatedAt: '2026-08-16T08:00:00.000Z',
  effectivePermissions: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
};

describe('[AUTH-003][AUTH-009][AUTH-014] M01 Platform API', () => {
  let application: INestApplication;
  const create = jest.fn(async () => createdSpace);
  const repository = {
    create,
    list: jest.fn(async () => [createdSpace]),
    resolvePermissions: jest.fn(async () => ['READ', 'WRITE', 'REVIEW', 'ADMIN']),
  } as unknown as KnowledgeSpaceRepository;
  const cache = {
    get: jest.fn(async () => undefined),
    set: jest.fn(async () => undefined),
    invalidateAll: jest.fn(async () => undefined),
  } as unknown as AuthorizationCachePort;
  const audit = {
    append: jest.fn(async () => undefined),
    appendAuthenticationDenied: jest.fn(async () => undefined),
  } as unknown as SecurityAuditPort;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PlatformApiModule] })
      .overrideProvider(AUTHORIZATION_VERSION_PROVIDER)
      .useValue({ getCurrentVersion: async () => 11 })
      .overrideProvider(KNOWLEDGE_SPACE_REPOSITORY)
      .useValue(repository)
      .overrideProvider(AUTHORIZATION_CACHE)
      .useValue(cache)
      .overrideProvider(SECURITY_AUDIT)
      .useValue(audit)
      .compile();
    application = module.createNestApplication();
    application.setGlobalPrefix('api/v1');
    await application.init();
  });

  afterAll(async () => {
    await application.close();
  });

  it('开发预置列表公开，但角色来自服务端映射', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/v1/auth/dev/presets')
      .expect(200);

    expect(response.body.data).toEqual(
      expect.objectContaining({
        selectionHeader: 'x-rag-mock-user',
        items: expect.arrayContaining([
          expect.objectContaining({ presetId: 'dev-admin', roles: ['SYSTEM_ADMIN'] }),
        ]),
      }),
    );
  });

  it('Mock 选择只提交 presetId，服务端建立可信上下文', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-rag-mock-user', 'knowledge-editor')
      .expect(200);

    expect(response.body.data.user).toEqual(
      expect.objectContaining({
        userId: 'knowledge-editor',
        roles: ['KNOWLEDGE_EDITOR'],
        authzVersion: 11,
      }),
    );
  });

  it('未知预置身份 fail-closed 并返回稳定错误码', async () => {
    const response = await request(application.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-rag-mock-user', 'forged-admin')
      .expect(401);

    expect(response.body).toEqual(
      expect.objectContaining({ code: 'AUTH_INVALID', retryable: false }),
    );
  });

  it('阅读者伪造角色 Header 仍不能创建空间', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/v1/spaces')
      .set('x-rag-mock-user', 'knowledge-reader')
      .set('x-authenticated-roles', 'SYSTEM_ADMIN')
      .send({ code: 'forged-space', name: '越权知识库', description: null })
      .expect(403);

    expect(response.body).toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }));
    expect(create).not.toHaveBeenCalled();
  });

  it('系统管理员可以创建空间并得到统一信封', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/v1/spaces')
      .set('x-rag-mock-user', 'dev-admin')
      .send({ code: 'hr-policy', name: '人力制度库', description: null })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        requestId: expect.any(String),
        data: expect.objectContaining({
          id: createdSpace.id,
          effectivePermissions: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
        }),
      }),
    );
  });
});
