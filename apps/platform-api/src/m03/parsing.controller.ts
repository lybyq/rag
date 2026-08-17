/** M03 Parse Run、Block 与 Provider Profile 管理 HTTP Adapter。 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { DocumentProcessingAdminService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  ListDocumentBlocksQuerySchema,
  type ApiEnvelope,
  type DocumentBlock,
  type DocumentParseRun,
  type ParseIssue,
  type ProcessingProviderProfile,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from '../m02/m02-http-utils';

const IdSchema = z.uuid();

@Controller('document-versions/:versionId/parse-runs')
export class DocumentVersionParseRunsController {
  public constructor(
    @Inject(DocumentProcessingAdminService)
    private readonly processing: DocumentProcessingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get()
  public async list(
    @CurrentUser() user: UserContext,
    @Param('versionId') rawVersionId: string,
  ): Promise<ApiEnvelope<{ items: readonly DocumentParseRun[] }>> {
    const versionId = parseInput(IdSchema, rawVersionId);
    const items = await this.processing.listRuns(
      toAccessContext(user, this.requestContext),
      versionId,
    );
    return envelope(this.requestContext, { items });
  }
}

@Controller('parse-runs')
export class ParseRunsController {
  public constructor(
    @Inject(DocumentProcessingAdminService)
    private readonly processing: DocumentProcessingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get(':parseRunId/blocks')
  public async blocks(
    @CurrentUser() user: UserContext,
    @Param('parseRunId') rawParseRunId: string,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly DocumentBlock[]; nextOrdinal: number | null }>> {
    const parseRunId = parseInput(IdSchema, rawParseRunId);
    const query = parseInput(ListDocumentBlocksQuerySchema, rawQuery);
    return envelope(
      this.requestContext,
      await this.processing.listBlocks(
        toAccessContext(user, this.requestContext),
        parseRunId,
        query,
      ),
    );
  }

  @Get(':parseRunId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('parseRunId') rawParseRunId: string,
  ): Promise<ApiEnvelope<{ run: DocumentParseRun; issues: readonly ParseIssue[] }>> {
    const parseRunId = parseInput(IdSchema, rawParseRunId);
    return envelope(
      this.requestContext,
      await this.processing.getRun(toAccessContext(user, this.requestContext), parseRunId),
    );
  }
}

@Controller('parsing/profiles')
export class ParsingProfilesController {
  public constructor(
    @Inject(DocumentProcessingAdminService)
    private readonly processing: DocumentProcessingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get()
  public list(
    @CurrentUser() user: UserContext,
  ): ApiEnvelope<{ items: readonly ProcessingProviderProfile[] }> {
    return envelope(this.requestContext, {
      items: this.processing.listProfiles(toAccessContext(user, this.requestContext)),
    });
  }
}
