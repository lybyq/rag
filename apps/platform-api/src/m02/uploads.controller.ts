/** 上传会话 HTTP Adapter；请求体只有元数据，文件字节不会进入本 Controller。 */
import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { DocumentIngestionService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CompleteUploadRequestSchema,
  CreateUploadPartsRequestSchema,
  CreateUploadSessionRequestSchema,
  type ApiEnvelope,
  type CompleteUploadResult,
  type UploadPartInstruction,
  type UploadSession,
  type UserContext,
} from '@rag/contracts';
import { MetricsService, RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from './m02-http-utils';

const UploadIdSchema = z.uuid();

@Controller('uploads')
export class UploadsController {
  public constructor(
    @Inject(DocumentIngestionService) private readonly ingestion: DocumentIngestionService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** 创建单文件或最多 100 文件的直传会话。 */
  @Post()
  public async create(
    @CurrentUser() user: UserContext,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<UploadSession>> {
    const body = parseInput(CreateUploadSessionRequestSchema, rawBody);
    const session = await this.ingestion.createUploadSession(
      toAccessContext(user, this.requestContext),
      body,
    );
    this.metrics.m02OperationsTotal.inc({ operation: 'upload_session_create', result: 'success' });
    return envelope(this.requestContext, session);
  }

  /** 页面刷新后重新读取会话并签发新的短时单 PUT URL。 */
  @Get(':uploadId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('uploadId') rawUploadId: string,
  ): Promise<ApiEnvelope<UploadSession>> {
    const uploadId = parseInput(UploadIdSchema, rawUploadId);
    const session = await this.ingestion.getUploadSession(
      toAccessContext(user, this.requestContext),
      uploadId,
    );
    return envelope(this.requestContext, session);
  }

  /** 按需签发指定分片，失败分片可独立重试。 */
  @Post(':uploadId/parts')
  public async createParts(
    @CurrentUser() user: UserContext,
    @Param('uploadId') rawUploadId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<{ items: readonly UploadPartInstruction[] }>> {
    const uploadId = parseInput(UploadIdSchema, rawUploadId);
    const body = parseInput(CreateUploadPartsRequestSchema, rawBody);
    const items = await this.ingestion.createUploadParts(
      toAccessContext(user, this.requestContext),
      uploadId,
      body,
    );
    return envelope(this.requestContext, { items });
  }

  /** HEAD 验证对象后提交业务事实事务；重复调用返回原结果。 */
  @Post(':uploadId/complete')
  public async complete(
    @CurrentUser() user: UserContext,
    @Param('uploadId') rawUploadId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<CompleteUploadResult>> {
    const uploadId = parseInput(UploadIdSchema, rawUploadId);
    const body = parseInput(CompleteUploadRequestSchema, rawBody);
    const result = await this.ingestion.completeUpload(
      toAccessContext(user, this.requestContext),
      uploadId,
      body,
    );
    this.metrics.m02OperationsTotal.inc({ operation: 'upload_complete', result: 'success' });
    return envelope(this.requestContext, result);
  }

  /** 关闭会话并尽力清理未完成对象。 */
  @Delete(':uploadId')
  public async cancel(
    @CurrentUser() user: UserContext,
    @Param('uploadId') rawUploadId: string,
  ): Promise<ApiEnvelope<{ cancelled: true }>> {
    const uploadId = parseInput(UploadIdSchema, rawUploadId);
    await this.ingestion.cancelUploadSession(toAccessContext(user, this.requestContext), uploadId);
    this.metrics.m02OperationsTotal.inc({ operation: 'upload_cancel', result: 'success' });
    return envelope(this.requestContext, { cancelled: true });
  }
}
