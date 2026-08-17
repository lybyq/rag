/**
 * M04 知识加工运行、Chunk、质量报告和人工审核 HTTP Adapter。
 * Controller 只做 Zod 输入映射、调用 Use Case 和 API Envelope 映射，不包含权限、审核状态或事务规则。
 *
 * @requirement KNO-011
 * @requirement KNO-012
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { KnowledgeProcessingAdminService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  ListKnowledgeChunksQuerySchema,
  ReviewQualityRequestSchema,
  type ApiEnvelope,
  type DocumentQualityReport,
  type KnowledgeChunk,
  type KnowledgeProcessingRun,
  type QualityFinding,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from '../m02/m02-http-utils';

const IdSchema = z.uuid();

/** 文档版本下的知识加工历史入口。 */
@Controller('document-versions/:versionId/knowledge-runs')
export class DocumentVersionKnowledgeRunsController {
  public constructor(
    @Inject(KnowledgeProcessingAdminService)
    private readonly processing: KnowledgeProcessingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get()
  public async list(
    @CurrentUser() user: UserContext,
    @Param('versionId') rawVersionId: string,
  ): Promise<ApiEnvelope<{ items: readonly KnowledgeProcessingRun[] }>> {
    const versionId = parseInput(IdSchema, rawVersionId);
    const items = await this.processing.listRuns(
      toAccessContext(user, this.requestContext),
      versionId,
    );
    return envelope(this.requestContext, { items });
  }
}

/** 单次知识加工运行的检查与审核入口。 */
@Controller('knowledge-runs')
export class KnowledgeProcessingRunsController {
  public constructor(
    @Inject(KnowledgeProcessingAdminService)
    private readonly processing: KnowledgeProcessingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get(':processingRunId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('processingRunId') rawProcessingRunId: string,
  ): Promise<
    ApiEnvelope<{
      run: KnowledgeProcessingRun;
      report: DocumentQualityReport;
      findings: readonly QualityFinding[];
    }>
  > {
    const processingRunId = parseInput(IdSchema, rawProcessingRunId);
    return envelope(
      this.requestContext,
      await this.processing.getRun(toAccessContext(user, this.requestContext), processingRunId),
    );
  }

  @Get(':processingRunId/chunks')
  public async chunks(
    @CurrentUser() user: UserContext,
    @Param('processingRunId') rawProcessingRunId: string,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly KnowledgeChunk[]; nextOrdinal: number | null }>> {
    const processingRunId = parseInput(IdSchema, rawProcessingRunId);
    const query = parseInput(ListKnowledgeChunksQuerySchema, rawQuery);
    return envelope(
      this.requestContext,
      await this.processing.listChunks(
        toAccessContext(user, this.requestContext),
        processingRunId,
        query,
      ),
    );
  }

  @Post(':processingRunId/reviews')
  public async review(
    @CurrentUser() user: UserContext,
    @Param('processingRunId') rawProcessingRunId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<{ report: DocumentQualityReport; reprocessJobId: string | null }>> {
    const processingRunId = parseInput(IdSchema, rawProcessingRunId);
    const request = parseInput(ReviewQualityRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.processing.review(
        toAccessContext(user, this.requestContext),
        processingRunId,
        request,
      ),
    );
  }
}
