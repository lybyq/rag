/** 文档、版本和空间内上传入口 HTTP Adapter。 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { DocumentIngestionService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CreateSpaceDocumentUploadRequestSchema,
  ListDocumentsQuerySchema,
  ReprocessDocumentVersionRequestSchema,
  type ApiEnvelope,
  type CursorPage,
  type Document,
  type DocumentFile,
  type DocumentVersion,
  type IngestionJob,
  type UploadSession,
  type UserContext,
} from '@rag/contracts';
import { MetricsService, RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from './m02-http-utils';

const UuidSchema = z.uuid();

/** 兼容资源式 POST /spaces/{spaceId}/documents，返回的是直传会话。 */
@Controller('spaces/:spaceId/documents')
export class SpaceDocumentsController {
  public constructor(
    @Inject(DocumentIngestionService) private readonly ingestion: DocumentIngestionService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Post()
  public async createUpload(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<UploadSession>> {
    const spaceId = parseInput(UuidSchema, rawSpaceId);
    const body = parseInput(CreateSpaceDocumentUploadRequestSchema, rawBody);
    const session = await this.ingestion.createUploadSession(
      toAccessContext(user, this.requestContext),
      { spaceId, files: body.files },
    );
    this.metrics.m02OperationsTotal.inc({ operation: 'upload_session_create', result: 'success' });
    return envelope(this.requestContext, session);
  }
}

@Controller()
export class DocumentsController {
  public constructor(
    @Inject(DocumentIngestionService) private readonly ingestion: DocumentIngestionService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get('documents')
  public async list(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly Document[]; page: CursorPage }>> {
    const query = parseInput(ListDocumentsQuerySchema, rawQuery);
    const result = await this.ingestion.listDocuments(
      toAccessContext(user, this.requestContext),
      query,
    );
    return envelope(this.requestContext, {
      items: result.items,
      page: { nextCursor: result.nextCursor, hasMore: result.hasMore },
    });
  }

  @Get('documents/:documentId')
  public async getDocument(
    @CurrentUser() user: UserContext,
    @Param('documentId') rawDocumentId: string,
  ): Promise<ApiEnvelope<{ document: Document; versions: readonly DocumentVersion[] }>> {
    const documentId = parseInput(UuidSchema, rawDocumentId);
    return envelope(
      this.requestContext,
      await this.ingestion.getDocument(toAccessContext(user, this.requestContext), documentId),
    );
  }

  @Get('document-versions/:versionId')
  public async getVersion(
    @CurrentUser() user: UserContext,
    @Param('versionId') rawVersionId: string,
  ): Promise<ApiEnvelope<{ version: DocumentVersion; files: readonly DocumentFile[] }>> {
    const versionId = parseInput(UuidSchema, rawVersionId);
    return envelope(
      this.requestContext,
      await this.ingestion.getDocumentVersion(
        toAccessContext(user, this.requestContext),
        versionId,
      ),
    );
  }

  @Post('document-versions/:versionId/reprocess')
  public async reprocess(
    @CurrentUser() user: UserContext,
    @Param('versionId') rawVersionId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<IngestionJob>> {
    const versionId = parseInput(UuidSchema, rawVersionId);
    const body = parseInput(ReprocessDocumentVersionRequestSchema, rawBody);
    const job = await this.ingestion.reprocessDocumentVersion(
      toAccessContext(user, this.requestContext),
      versionId,
      body.expectedVersion,
      body.reason,
    );
    this.metrics.m02OperationsTotal.inc({ operation: 'version_reprocess', result: 'success' });
    return envelope(this.requestContext, job);
  }
}
