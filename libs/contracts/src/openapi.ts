/**
 * 从 Zod 契约生成 OpenAPI 3.1 文档。
 * OpenAPI 3.1 直接兼容 JSON Schema，使 Zod 可以保持运行时契约真相。
 *
 * @requirement BASE-006
 */
import { z } from 'zod';
import { ApiErrorSchema } from './api-envelope';
import { ServiceHealthEnvelopeSchema } from './health';
import {
  CreateKnowledgeSpaceRequestSchema,
  DeactivateKnowledgeSpaceRequestSchema,
  DevelopmentIdentityPresetListEnvelopeSchema,
  KnowledgeSpaceEnvelopeSchema,
  KnowledgeSpaceListEnvelopeSchema,
  PolicyVersionListEnvelopeSchema,
  RevokeSpaceGrantEnvelopeSchema,
  RevokeSpaceGrantRequestSchema,
  SpaceGrantEnvelopeSchema,
  SpaceGrantListEnvelopeSchema,
  UpdateKnowledgeSpaceRequestSchema,
  UpsertSpaceGrantRequestSchema,
  UserContextEnvelopeSchema,
} from './knowledge-space';

/** 生成文档所需的最小服务信息。 */
export interface OpenApiDocumentOptions {
  title: string;
  description: string;
  version: string;
  /** Platform API 才注册 M01 管理路径；Query 服务只保留自己的模块。 */
  includeM01?: boolean;
}

/** OpenAPI 文档使用普通 JSON 对象表示，便于 NestJS 和生成脚本共同消费。 */
export type OpenApiDocument = Record<string, unknown>;

/**
 * 创建所有后端应用共享的基础 OpenAPI 文档。
 * 后续模块会在这里注册版本化业务 Schema 和 Path。
 */
export function buildBaseOpenApiDocument(options: OpenApiDocumentOptions): OpenApiDocument {
  const errorResponse = (description: string): Record<string, unknown> => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  });
  const jsonResponse = (description: string, schema: string): Record<string, unknown> => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  });
  const jsonBody = (schema: string): Record<string, unknown> => ({
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  });
  const spaceIdParameter = {
    name: 'spaceId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  };
  const securedResponses = {
    '401': errorResponse('身份缺失或无法验证'),
    '403': errorResponse('当前身份无权执行操作'),
  };
  const m01Paths: Record<string, unknown> = options.includeM01
    ? {
        '/api/v1/auth/me': {
          get: {
            operationId: 'getCurrentIdentity',
            summary: '读取服务端解析后的当前身份',
            security: [{ bearerAuth: [] }, { trustedUserHeader: [] }, { mockPreset: [] }],
            responses: {
              '200': jsonResponse('当前身份', 'UserContextEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/auth/dev/presets': {
          get: {
            operationId: 'listDevelopmentIdentityPresets',
            summary: '列出非生产 Mock 身份预置',
            responses: {
              '200': jsonResponse('开发身份预置', 'DevelopmentIdentityPresetListEnvelope'),
              '404': errorResponse('非 Mock 模式不暴露此端点'),
            },
          },
        },
        '/api/v1/spaces': {
          get: {
            operationId: 'listKnowledgeSpaces',
            summary: '列出当前身份可见的知识空间',
            parameters: [
              { name: 'search', in: 'query', schema: { type: 'string', maxLength: 80 } },
              { name: 'status', in: 'query', schema: { enum: ['ACTIVE', 'INACTIVE'] } },
            ],
            responses: {
              '200': jsonResponse('可见知识空间', 'KnowledgeSpaceListEnvelope'),
              ...securedResponses,
            },
          },
          post: {
            operationId: 'createKnowledgeSpace',
            summary: '创建知识空间并给负责人 ADMIN 权限',
            requestBody: jsonBody('CreateKnowledgeSpaceRequest'),
            responses: {
              '201': jsonResponse('已创建空间', 'KnowledgeSpaceEnvelope'),
              '409': errorResponse('空间编码冲突'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}': {
          get: {
            operationId: 'getKnowledgeSpace',
            summary: '读取一个可访问空间',
            parameters: [spaceIdParameter],
            responses: {
              '200': jsonResponse('知识空间', 'KnowledgeSpaceEnvelope'),
              '404': errorResponse('空间不存在'),
              ...securedResponses,
            },
          },
          patch: {
            operationId: 'updateKnowledgeSpace',
            summary: '乐观锁更新空间基本信息',
            parameters: [spaceIdParameter],
            requestBody: jsonBody('UpdateKnowledgeSpaceRequest'),
            responses: {
              '200': jsonResponse('已更新空间', 'KnowledgeSpaceEnvelope'),
              '409': errorResponse('版本冲突'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}/deactivate': {
          post: {
            operationId: 'deactivateKnowledgeSpace',
            summary: '停用知识空间',
            parameters: [spaceIdParameter],
            requestBody: jsonBody('DeactivateKnowledgeSpaceRequest'),
            responses: {
              '201': jsonResponse('已停用空间', 'KnowledgeSpaceEnvelope'),
              '409': errorResponse('版本冲突'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}/grants': {
          get: {
            operationId: 'listSpaceGrants',
            summary: '列出空间 ACL',
            parameters: [spaceIdParameter],
            responses: {
              '200': jsonResponse('ACL 列表', 'SpaceGrantListEnvelope'),
              ...securedResponses,
            },
          },
          put: {
            operationId: 'upsertSpaceGrant',
            summary: '创建或替换 USER/ROLE 授权',
            parameters: [spaceIdParameter],
            requestBody: jsonBody('UpsertSpaceGrantRequest'),
            responses: {
              '200': jsonResponse('授权记录', 'SpaceGrantEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}/grants/{grantId}': {
          delete: {
            operationId: 'revokeSpaceGrant',
            summary: '撤销空间授权',
            parameters: [
              spaceIdParameter,
              {
                name: 'grantId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            requestBody: jsonBody('RevokeSpaceGrantRequest'),
            responses: {
              '200': jsonResponse('撤权结果', 'RevokeSpaceGrantEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}/policy-versions': {
          get: {
            operationId: 'listSpacePolicyVersions',
            summary: '列出不可变 ACL 策略版本',
            parameters: [spaceIdParameter],
            responses: {
              '200': jsonResponse('策略版本', 'PolicyVersionListEnvelope'),
              ...securedResponses,
            },
          },
        },
      }
    : {};

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      description: options.description,
      version: options.version,
    },
    paths: {
      '/api/v1/health/live': {
        get: {
          operationId: 'getLiveness',
          summary: '检查进程是否存活',
          responses: {
            '200': {
              description: '进程存活',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ServiceHealthEnvelope' },
                },
              },
            },
          },
        },
      },
      '/api/v1/health/ready': {
        get: {
          operationId: 'getReadiness',
          summary: '检查关键依赖是否就绪',
          responses: {
            '200': {
              description: '所有关键依赖就绪',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ServiceHealthEnvelope' },
                },
              },
            },
            '503': {
              description: '至少一个关键依赖不可用',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ServiceHealthEnvelope' },
                },
              },
            },
          },
        },
      },
      ...m01Paths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        trustedUserHeader: { type: 'apiKey', in: 'header', name: 'X-Authenticated-User' },
        mockPreset: { type: 'apiKey', in: 'header', name: 'X-RAG-Mock-User' },
      },
      schemas: {
        ApiError: z.toJSONSchema(ApiErrorSchema),
        ServiceHealthEnvelope: z.toJSONSchema(ServiceHealthEnvelopeSchema),
        ...(options.includeM01
          ? {
              UserContextEnvelope: z.toJSONSchema(UserContextEnvelopeSchema),
              DevelopmentIdentityPresetListEnvelope: z.toJSONSchema(
                DevelopmentIdentityPresetListEnvelopeSchema,
              ),
              CreateKnowledgeSpaceRequest: z.toJSONSchema(CreateKnowledgeSpaceRequestSchema),
              UpdateKnowledgeSpaceRequest: z.toJSONSchema(UpdateKnowledgeSpaceRequestSchema),
              DeactivateKnowledgeSpaceRequest: z.toJSONSchema(
                DeactivateKnowledgeSpaceRequestSchema,
              ),
              UpsertSpaceGrantRequest: z.toJSONSchema(UpsertSpaceGrantRequestSchema),
              RevokeSpaceGrantRequest: z.toJSONSchema(RevokeSpaceGrantRequestSchema),
              KnowledgeSpaceEnvelope: z.toJSONSchema(KnowledgeSpaceEnvelopeSchema),
              KnowledgeSpaceListEnvelope: z.toJSONSchema(KnowledgeSpaceListEnvelopeSchema),
              SpaceGrantEnvelope: z.toJSONSchema(SpaceGrantEnvelopeSchema),
              SpaceGrantListEnvelope: z.toJSONSchema(SpaceGrantListEnvelopeSchema),
              RevokeSpaceGrantEnvelope: z.toJSONSchema(RevokeSpaceGrantEnvelopeSchema),
              PolicyVersionListEnvelope: z.toJSONSchema(PolicyVersionListEnvelopeSchema),
            }
          : {}),
      },
    },
  };
}
