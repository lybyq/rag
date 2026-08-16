/**
 * 从 Zod 契约生成 OpenAPI 3.1 文档。
 * OpenAPI 3.1 直接兼容 JSON Schema，使 Zod 可以保持运行时契约真相。
 *
 * @requirement BASE-006
 */
import { z } from 'zod';
import { ApiErrorSchema } from './api-envelope';
import { ServiceHealthEnvelopeSchema } from './health';

/** 生成文档所需的最小服务信息。 */
export interface OpenApiDocumentOptions {
  title: string;
  description: string;
  version: string;
}

/** OpenAPI 文档使用普通 JSON 对象表示，便于 NestJS 和生成脚本共同消费。 */
export type OpenApiDocument = Record<string, unknown>;

/**
 * 创建所有后端应用共享的基础 OpenAPI 文档。
 * 后续模块会在这里注册版本化业务 Schema 和 Path。
 */
export function buildBaseOpenApiDocument(options: OpenApiDocumentOptions): OpenApiDocument {
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
    },
    components: {
      schemas: {
        ApiError: z.toJSONSchema(ApiErrorSchema),
        ServiceHealthEnvelope: z.toJSONSchema(ServiceHealthEnvelopeSchema),
      },
    },
  };
}
