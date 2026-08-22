/**
 * M05 索引运行、对账、Manifest 回滚和 Profile 重建 HTTP Adapter。
 * Controller 只执行 Zod 输入映射、调用 Use Case 和 Envelope 映射，不接受任意 Collection 名或 Milvus Filter。
 *
 * @requirement IDX-010
 * @requirement IDX-012
 * @requirement IDX-016
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { IndexingAdminService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  RollbackManifestRequestSchema,
  IndexRebuildDecisionRequestSchema,
  StartIndexRebuildRequestSchema,
  type ApiEnvelope,
  type IndexingRun,
  type IndexRebuild,
  type IndexReconciliationReport,
  type SpaceManifest,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from '../m02/m02-http-utils';

const IdSchema = z.uuid();

/** 单次索引运行及对账报告入口。 */
@Controller('indexing-runs')
export class IndexingRunsController {
  public constructor(
    @Inject(IndexingAdminService) private readonly indexing: IndexingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get(':indexingRunId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('indexingRunId') rawId: string,
  ): Promise<ApiEnvelope<IndexingRun>> {
    const id = parseInput(IdSchema, rawId);
    return envelope(
      this.requestContext,
      await this.indexing.getRun(toAccessContext(user, this.requestContext), id),
    );
  }

  @Get(':indexingRunId/reconciliation')
  public async reconciliation(
    @CurrentUser() user: UserContext,
    @Param('indexingRunId') rawId: string,
  ): Promise<ApiEnvelope<IndexReconciliationReport>> {
    const id = parseInput(IdSchema, rawId);
    return envelope(
      this.requestContext,
      await this.indexing.getReconciliation(toAccessContext(user, this.requestContext), id),
    );
  }
}

/** 空间级 Manifest 历史、回滚和 Profile 重建入口。 */
@Controller('spaces/:spaceId/index')
export class SpaceIndexController {
  public constructor(
    @Inject(IndexingAdminService) private readonly indexing: IndexingAdminService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get('manifests')
  public async manifests(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
  ): Promise<ApiEnvelope<{ items: readonly SpaceManifest[] }>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    return envelope(this.requestContext, {
      items: await this.indexing.listManifests(toAccessContext(user, this.requestContext), spaceId),
    });
  }

  @Post('manifests/rollback')
  public async rollback(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<SpaceManifest>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    const request = parseInput(RollbackManifestRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.indexing.rollback(toAccessContext(user, this.requestContext), spaceId, request),
    );
  }

  @Post('rebuilds')
  public async rebuild(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<{ requestId: string }>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    const request = parseInput(StartIndexRebuildRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.indexing.rebuild(toAccessContext(user, this.requestContext), spaceId, request),
    );
  }

  @Get('rebuilds/:requestId')
  public async getRebuild(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Param('requestId') rawRequestId: string,
  ): Promise<ApiEnvelope<IndexRebuild>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    const requestId = parseInput(IdSchema, rawRequestId);
    return envelope(
      this.requestContext,
      await this.indexing.getRebuild(
        toAccessContext(user, this.requestContext),
        spaceId,
        requestId,
      ),
    );
  }

  @Post('rebuilds/:requestId/promote')
  public async promoteRebuild(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Param('requestId') rawRequestId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<SpaceManifest>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    const requestId = parseInput(IdSchema, rawRequestId);
    const request = parseInput(IndexRebuildDecisionRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.indexing.promoteRebuild(
        toAccessContext(user, this.requestContext),
        spaceId,
        requestId,
        request,
      ),
    );
  }

  @Post('rebuilds/:requestId/rollback')
  public async rollbackRebuild(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Param('requestId') rawRequestId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<SpaceManifest>> {
    const spaceId = parseInput(IdSchema, rawSpaceId);
    const requestId = parseInput(IdSchema, rawRequestId);
    const request = parseInput(IndexRebuildDecisionRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.indexing.rollbackRebuild(
        toAccessContext(user, this.requestContext),
        spaceId,
        requestId,
        request,
      ),
    );
  }
}
