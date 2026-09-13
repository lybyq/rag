/**
 * 外部业务批量导入 HTTP 入口。
 *
 * 创建接口只提交文件元数据并返回逐文件预签名上传计划；文件字节仍直传对象存储。查询接口
 * 返回逐文件上传/Job 状态。身份继续来自统一 CurrentUser，不能由业务请求自报管理员角色。
 *
 * @requirement OPT-013
 */
import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { DocumentIngestionService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CreateDocumentBatchRequestSchema,
  type ApiEnvelope,
  type CreateDocumentBatchResult,
  type DocumentBatchStatus,
  type UserContext,
} from '@rag/contracts';
import { MetricsService, RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../identity-access/http-utils';
import { toAccessContext } from './ingestion-http-utils';

const UuidSchema = z.uuid();
const IdempotencyKeySchema = z.string().trim().min(8).max(200);

@Controller()
export class DocumentBatchesController {
  public constructor(
    @Inject(DocumentIngestionService) private readonly ingestion: DocumentIngestionService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** 创建最多 100 文件的批量直传计划；batchId 就是可恢复上传会话 ID。 */
  @Post('spaces/:spaceId/document-batches')
  public async create(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<CreateDocumentBatchResult>> {
    const spaceId = parseInput(UuidSchema, rawSpaceId);
    const idempotencyKey = parseInput(IdempotencyKeySchema, rawIdempotencyKey);
    const body = parseInput(CreateDocumentBatchRequestSchema, rawBody);
    const result = await this.ingestion.createDocumentBatch(
      toAccessContext(user, this.requestContext),
      spaceId,
      idempotencyKey,
      body,
    );
    this.metrics.documentIngestionOperationsTotal.inc({
      operation: 'document_batch_create',
      result: 'success',
    });
    return envelope(this.requestContext, result);
  }

  /** 按批次轮询逐文件真实状态；权限沿用创建者及空间 WRITE 门禁。 */
  @Get('document-batches/:batchId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('batchId') rawBatchId: string,
  ): Promise<ApiEnvelope<DocumentBatchStatus>> {
    const batchId = parseInput(UuidSchema, rawBatchId);
    return envelope(
      this.requestContext,
      await this.ingestion.getDocumentBatch(toAccessContext(user, this.requestContext), batchId),
    );
  }
}
