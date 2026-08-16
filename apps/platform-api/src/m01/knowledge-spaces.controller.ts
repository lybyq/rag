/** 知识空间、ACL 与策略版本 HTTP Adapter。 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AccessContext } from '@rag/application';
import { KnowledgeSpaceService } from '@rag/application';
import {
  CreateKnowledgeSpaceRequestSchema,
  DeactivateKnowledgeSpaceRequestSchema,
  ListKnowledgeSpacesQuerySchema,
  RevokeSpaceGrantRequestSchema,
  UpdateKnowledgeSpaceRequestSchema,
  UpsertSpaceGrantRequestSchema,
  type ApiEnvelope,
  type KnowledgeSpace,
  type KnowledgeSpacePolicyVersion,
  type SpaceGrant,
  type UserContext,
} from '@rag/contracts';
import { CurrentUser } from '@rag/auth';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { envelope, parseInput } from './http-utils';

const SpaceIdSchema = z.uuid();

@Controller('spaces')
export class KnowledgeSpacesController {
  public constructor(
    @Inject(KnowledgeSpaceService) private readonly spaces: KnowledgeSpaceService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get()
  public async list(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly KnowledgeSpace[]; total: number }>> {
    const query = parseInput(ListKnowledgeSpacesQuerySchema, rawQuery);
    const items = await this.spaces.list(this.accessContext(user), query);
    return envelope(this.requestContext, { items, total: items.length });
  }

  @Post()
  public async create(
    @CurrentUser() user: UserContext,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<KnowledgeSpace>> {
    const body = parseInput(CreateKnowledgeSpaceRequestSchema, rawBody);
    return envelope(this.requestContext, await this.spaces.create(this.accessContext(user), body));
  }

  @Get(':spaceId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
  ): Promise<ApiEnvelope<KnowledgeSpace>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    return envelope(this.requestContext, await this.spaces.get(this.accessContext(user), spaceId));
  }

  @Patch(':spaceId')
  public async update(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<KnowledgeSpace>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const body = parseInput(UpdateKnowledgeSpaceRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.spaces.update(this.accessContext(user), spaceId, body),
    );
  }

  @Post(':spaceId/deactivate')
  public async deactivate(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<KnowledgeSpace>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const body = parseInput(DeactivateKnowledgeSpaceRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.spaces.deactivate(
        this.accessContext(user),
        spaceId,
        body.expectedVersion,
        body.reason,
      ),
    );
  }

  @Get(':spaceId/grants')
  public async listGrants(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
  ): Promise<ApiEnvelope<{ items: readonly SpaceGrant[] }>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const items = await this.spaces.listGrants(this.accessContext(user), spaceId);
    return envelope(this.requestContext, { items });
  }

  @Put(':spaceId/grants')
  public async upsertGrant(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<SpaceGrant>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const body = parseInput(UpsertSpaceGrantRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.spaces.upsertGrant(this.accessContext(user), spaceId, body),
    );
  }

  @Delete(':spaceId/grants/:grantId')
  public async revokeGrant(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
    @Param('grantId') rawGrantId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<{ revoked: true }>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const grantId = parseInput(z.uuid(), rawGrantId);
    const body = parseInput(RevokeSpaceGrantRequestSchema, rawBody);
    await this.spaces.revokeGrant(this.accessContext(user), spaceId, grantId, body);
    return envelope(this.requestContext, { revoked: true });
  }

  @Get(':spaceId/policy-versions')
  public async listPolicyVersions(
    @CurrentUser() user: UserContext,
    @Param('spaceId') rawSpaceId: string,
  ): Promise<ApiEnvelope<{ items: readonly KnowledgeSpacePolicyVersion[] }>> {
    const spaceId = parseInput(SpaceIdSchema, rawSpaceId);
    const items = await this.spaces.listPolicyVersions(this.accessContext(user), spaceId);
    return envelope(this.requestContext, { items });
  }

  /** 将可信身份和请求关联 ID 组合成显式 Repository 上下文。 */
  private accessContext(user: UserContext): AccessContext {
    const context = this.requestContext.get();
    return {
      user,
      requestId: context?.requestId ?? this.requestContext.getRequestId(),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
    };
  }
}
