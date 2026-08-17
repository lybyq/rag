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
  CancelIngestionJobRequestSchema,
  CompleteUploadEnvelopeSchema,
  CompleteUploadRequestSchema,
  CreateUploadPartsRequestSchema,
  CreateSpaceDocumentUploadRequestSchema,
  CreateUploadSessionRequestSchema,
  DocumentEnvelopeSchema,
  DocumentListEnvelopeSchema,
  DocumentVersionEnvelopeSchema,
  IngestionJobEnvelopeSchema,
  IngestionJobEventListEnvelopeSchema,
  IngestionJobListEnvelopeSchema,
  ReprocessDocumentVersionRequestSchema,
  UploadPartListEnvelopeSchema,
  UploadSessionEnvelopeSchema,
} from './document-ingestion';
import {
  DocumentBlockListEnvelopeSchema,
  ParseRunDetailEnvelopeSchema,
  ParseRunListEnvelopeSchema,
  ProcessingProviderProfileListEnvelopeSchema,
} from './document-parsing';
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
import {
  KnowledgeChunkListEnvelopeSchema,
  KnowledgeProcessingRunDetailEnvelopeSchema,
  KnowledgeProcessingRunListEnvelopeSchema,
  QualityReviewResultEnvelopeSchema,
  ReviewQualityRequestSchema,
} from './knowledge-processing';

/** 生成文档所需的最小服务信息。 */
export interface OpenApiDocumentOptions {
  title: string;
  description: string;
  version: string;
  /** Platform API 才注册 M01 管理路径；Query 服务只保留自己的模块。 */
  includeM01?: boolean;
  /** Platform API 注册 M02 文档接入和任务中心路径。 */
  includeM02?: boolean;
  /** Platform API 注册 M03 Parse Run、Block 与 Provider Profile 路径。 */
  includeM03?: boolean;
  /** Platform API 注册 M04 Chunk、质量报告与人工审核路径。 */
  includeM04?: boolean;
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
  const uuidPathParameter = (name: string): Record<string, unknown> => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  });
  const textPathParameter = (name: string): Record<string, unknown> => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 300 },
  });
  const documentListParameters = [
    { name: 'spaceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
    { name: 'status', in: 'query', schema: { enum: ['ACTIVE', 'ARCHIVED'] } },
    { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
  ];
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
  const m02Paths: Record<string, unknown> = options.includeM02
    ? {
        '/api/v1/uploads': {
          post: {
            operationId: 'createUploadSession',
            summary: '创建浏览器直传会话',
            requestBody: jsonBody('CreateUploadSessionRequest'),
            responses: {
              '201': jsonResponse('上传会话和短时预签名 URL', 'UploadSessionEnvelope'),
              '413': errorResponse('文件数量或大小超过配置上限'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/spaces/{spaceId}/documents': {
          post: {
            operationId: 'createSpaceDocumentUpload',
            summary: '在指定空间创建文档直传会话',
            parameters: [spaceIdParameter],
            requestBody: jsonBody('CreateSpaceDocumentUploadRequest'),
            responses: {
              '201': jsonResponse('上传会话', 'UploadSessionEnvelope'),
              '413': errorResponse('文件数量或大小超过配置上限'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/uploads/{uploadId}': {
          get: {
            operationId: 'getUploadSession',
            summary: '恢复上传会话',
            parameters: [uuidPathParameter('uploadId')],
            responses: {
              '200': jsonResponse('上传会话', 'UploadSessionEnvelope'),
              ...securedResponses,
            },
          },
          delete: {
            operationId: 'cancelUploadSession',
            summary: '取消上传会话',
            parameters: [uuidPathParameter('uploadId')],
            responses: { '200': { description: '已取消' }, ...securedResponses },
          },
        },
        '/api/v1/uploads/{uploadId}/parts': {
          post: {
            operationId: 'createUploadParts',
            summary: '按需签发 Multipart 分片 URL',
            parameters: [uuidPathParameter('uploadId')],
            requestBody: jsonBody('CreateUploadPartsRequest'),
            responses: {
              '201': jsonResponse('分片上传指令', 'UploadPartListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/uploads/{uploadId}/complete': {
          post: {
            operationId: 'completeUpload',
            summary: 'HEAD 验证对象并原子创建文档与任务事实',
            parameters: [uuidPathParameter('uploadId')],
            requestBody: jsonBody('CompleteUploadRequest'),
            responses: {
              '201': jsonResponse('文档、版本、文件和任务', 'CompleteUploadEnvelope'),
              '409': errorResponse('对象事实不匹配'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/documents': {
          get: {
            operationId: 'listDocuments',
            summary: '按权限游标分页列出文档',
            parameters: documentListParameters,
            responses: {
              '200': jsonResponse('文档列表', 'DocumentListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/documents/{documentId}': {
          get: {
            operationId: 'getDocument',
            summary: '读取文档和版本列表',
            parameters: [uuidPathParameter('documentId')],
            responses: {
              '200': jsonResponse('文档详情', 'DocumentEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/document-versions/{versionId}': {
          get: {
            operationId: 'getDocumentVersion',
            summary: '读取文档版本和文件事实',
            parameters: [uuidPathParameter('versionId')],
            responses: {
              '200': jsonResponse('版本详情', 'DocumentVersionEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/document-versions/{versionId}/reprocess': {
          post: {
            operationId: 'reprocessDocumentVersion',
            summary: '创建新的内容修订和任务',
            parameters: [uuidPathParameter('versionId')],
            requestBody: jsonBody('ReprocessDocumentVersionRequest'),
            responses: {
              '201': jsonResponse('新修订任务', 'IngestionJobEnvelope'),
              '409': errorResponse('乐观锁或状态冲突'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/jobs': {
          get: {
            operationId: 'listIngestionJobs',
            summary: '按权限游标分页列出入库任务',
            responses: {
              '200': jsonResponse('任务列表', 'IngestionJobListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/jobs/{jobId}': {
          get: {
            operationId: 'getIngestionJob',
            summary: '读取任务与步骤进度',
            parameters: [textPathParameter('jobId')],
            responses: {
              '200': jsonResponse('任务详情', 'IngestionJobEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/jobs/{jobId}/cancel': {
          post: {
            operationId: 'cancelIngestionJob',
            summary: '取消非终态任务',
            parameters: [textPathParameter('jobId')],
            requestBody: jsonBody('CancelIngestionJobRequest'),
            responses: {
              '201': jsonResponse('已取消任务', 'IngestionJobEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/jobs/{jobId}/events': {
          get: {
            operationId: 'streamIngestionJobEvents',
            summary: '使用 SSE 和 Last-Event-ID 续传任务事件',
            parameters: [
              textPathParameter('jobId'),
              { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 } },
            ],
            responses: {
              '200': { description: 'text/event-stream 任务事件' },
              ...securedResponses,
            },
          },
        },
        '/api/v1/jobs/{jobId}/events/poll': {
          get: {
            operationId: 'pollIngestionJobEvents',
            summary: '使用 ETag 和游标轮询任务事件',
            parameters: [
              textPathParameter('jobId'),
              { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } },
              { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
            ],
            responses: {
              '200': jsonResponse('任务事件', 'IngestionJobEventListEnvelope'),
              '304': { description: '没有新事件' },
              ...securedResponses,
            },
          },
        },
      }
    : {};
  const m03Paths: Record<string, unknown> = options.includeM03
    ? {
        '/api/v1/document-versions/{versionId}/parse-runs': {
          get: {
            operationId: 'listDocumentVersionParseRuns',
            summary: '列出文档版本的解析运行历史',
            parameters: [uuidPathParameter('versionId')],
            responses: {
              '200': jsonResponse('解析运行列表', 'ParseRunListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/parse-runs/{parseRunId}': {
          get: {
            operationId: 'getParseRun',
            summary: '读取解析运行、安全事实、耗时与问题',
            parameters: [uuidPathParameter('parseRunId')],
            responses: {
              '200': jsonResponse('解析运行详情', 'ParseRunDetailEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/parse-runs/{parseRunId}/blocks': {
          get: {
            operationId: 'listDocumentBlocks',
            summary: '按稳定 ordinal 分页预览统一 DocumentBlock',
            parameters: [
              uuidPathParameter('parseRunId'),
              { name: 'afterOrdinal', in: 'query', schema: { type: 'integer', minimum: 0 } },
              { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
            ],
            responses: {
              '200': jsonResponse('DocumentBlock 页面', 'DocumentBlockListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/parsing/profiles': {
          get: {
            operationId: 'listProcessingProviderProfiles',
            summary: '列出当前生效的扫描、Parser 与 OCR Profile',
            responses: {
              '200': jsonResponse('Provider Profile 列表', 'ProcessingProviderProfileListEnvelope'),
              ...securedResponses,
            },
          },
        },
      }
    : {};
  const m04Paths: Record<string, unknown> = options.includeM04
    ? {
        '/api/v1/document-versions/{versionId}/knowledge-runs': {
          get: {
            operationId: 'listDocumentVersionKnowledgeRuns',
            summary: '列出文档版本的知识加工运行历史',
            parameters: [uuidPathParameter('versionId')],
            responses: {
              '200': jsonResponse('知识加工运行列表', 'KnowledgeProcessingRunListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/knowledge-runs/{processingRunId}': {
          get: {
            operationId: 'getKnowledgeProcessingRun',
            summary: '读取知识加工运行、质量报告和发现项',
            parameters: [uuidPathParameter('processingRunId')],
            responses: {
              '200': jsonResponse('知识加工运行详情', 'KnowledgeProcessingRunDetailEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/knowledge-runs/{processingRunId}/chunks': {
          get: {
            operationId: 'listKnowledgeChunks',
            summary: '按稳定 ordinal 分页浏览 Parent/Child Chunk',
            parameters: [
              uuidPathParameter('processingRunId'),
              { name: 'afterOrdinal', in: 'query', schema: { type: 'integer', minimum: 0 } },
              { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
              { name: 'granularity', in: 'query', schema: { enum: ['PARENT', 'CHILD'] } },
            ],
            responses: {
              '200': jsonResponse('KnowledgeChunk 页面', 'KnowledgeChunkListEnvelope'),
              ...securedResponses,
            },
          },
        },
        '/api/v1/knowledge-runs/{processingRunId}/reviews': {
          post: {
            operationId: 'reviewKnowledgeQuality',
            summary: '乐观锁批准、拒绝或要求重处理',
            parameters: [uuidPathParameter('processingRunId')],
            requestBody: jsonBody('ReviewQualityRequest'),
            responses: {
              '201': jsonResponse('审核结果与可选重处理任务', 'QualityReviewResultEnvelope'),
              '409': errorResponse('报告版本冲突或审核状态不允许'),
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
      ...m02Paths,
      ...m03Paths,
      ...m04Paths,
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
        ...(options.includeM02
          ? {
              CreateUploadSessionRequest: z.toJSONSchema(CreateUploadSessionRequestSchema),
              CreateSpaceDocumentUploadRequest: z.toJSONSchema(
                CreateSpaceDocumentUploadRequestSchema,
              ),
              CreateUploadPartsRequest: z.toJSONSchema(CreateUploadPartsRequestSchema),
              CompleteUploadRequest: z.toJSONSchema(CompleteUploadRequestSchema),
              ReprocessDocumentVersionRequest: z.toJSONSchema(
                ReprocessDocumentVersionRequestSchema,
              ),
              CancelIngestionJobRequest: z.toJSONSchema(CancelIngestionJobRequestSchema),
              UploadSessionEnvelope: z.toJSONSchema(UploadSessionEnvelopeSchema),
              UploadPartListEnvelope: z.toJSONSchema(UploadPartListEnvelopeSchema),
              CompleteUploadEnvelope: z.toJSONSchema(CompleteUploadEnvelopeSchema),
              DocumentEnvelope: z.toJSONSchema(DocumentEnvelopeSchema),
              DocumentVersionEnvelope: z.toJSONSchema(DocumentVersionEnvelopeSchema),
              DocumentListEnvelope: z.toJSONSchema(DocumentListEnvelopeSchema),
              IngestionJobEnvelope: z.toJSONSchema(IngestionJobEnvelopeSchema),
              IngestionJobListEnvelope: z.toJSONSchema(IngestionJobListEnvelopeSchema),
              IngestionJobEventListEnvelope: z.toJSONSchema(IngestionJobEventListEnvelopeSchema),
            }
          : {}),
        ...(options.includeM03
          ? {
              ParseRunListEnvelope: z.toJSONSchema(ParseRunListEnvelopeSchema),
              ParseRunDetailEnvelope: z.toJSONSchema(ParseRunDetailEnvelopeSchema),
              DocumentBlockListEnvelope: z.toJSONSchema(DocumentBlockListEnvelopeSchema),
              ProcessingProviderProfileListEnvelope: z.toJSONSchema(
                ProcessingProviderProfileListEnvelopeSchema,
              ),
            }
          : {}),
        ...(options.includeM04
          ? {
              ReviewQualityRequest: z.toJSONSchema(ReviewQualityRequestSchema),
              KnowledgeProcessingRunListEnvelope: z.toJSONSchema(
                KnowledgeProcessingRunListEnvelopeSchema,
              ),
              KnowledgeProcessingRunDetailEnvelope: z.toJSONSchema(
                KnowledgeProcessingRunDetailEnvelopeSchema,
              ),
              KnowledgeChunkListEnvelope: z.toJSONSchema(KnowledgeChunkListEnvelopeSchema),
              QualityReviewResultEnvelope: z.toJSONSchema(QualityReviewResultEnvelopeSchema),
            }
          : {}),
      },
    },
  };
}
