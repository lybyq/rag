/**
 * 知识空间管理用例。
 * 控制器只负责协议转换；创建、更新、停用、授权和策略版本的业务次序都在这里。
 *
 * @requirement AUTH-009
 * @requirement AUTH-010
 * @requirement AUTH-012
 * @requirement AUTH-015
 */
import type {
  CreateKnowledgeSpaceRequest,
  KnowledgeSpace,
  KnowledgeSpacePolicyVersion,
  ListKnowledgeSpacesQuery,
  RevokeSpaceGrantRequest,
  SpaceGrant,
  UpdateKnowledgeSpaceRequest,
  UpsertSpaceGrantRequest,
} from '@rag/contracts';
import { isAllowedToCreateKnowledgeSpace } from '@rag/domain';
import { ApplicationError } from './application.error';
import type { AuthorizationService } from './authorization.service';
import type { AccessContext, KnowledgeSpaceRepository, SecurityAuditPort } from './ports';

export class KnowledgeSpaceService {
  public constructor(
    private readonly repository: KnowledgeSpaceRepository,
    private readonly authorization: AuthorizationService,
    private readonly audit: SecurityAuditPort,
  ) {}

  /** 创建者默认成为 owner，并由 Repository 原子写入 USER/ADMIN ACL。 */
  public async create(
    context: AccessContext,
    request: CreateKnowledgeSpaceRequest,
  ): Promise<KnowledgeSpace> {
    if (!isAllowedToCreateKnowledgeSpace(context.user.roles)) {
      await this.audit.append(context, {
        action: 'SPACE_CREATE',
        resourceType: 'KNOWLEDGE_SPACE',
        result: 'DENIED',
        reason: 'semantic role cannot create spaces',
      });
      throw new ApplicationError('ACCESS_DENIED', 403, '当前角色不能创建知识空间');
    }

    const ownerUserId = request.ownerUserId ?? context.user.userId;
    if (ownerUserId !== context.user.userId && !context.user.roles.includes('SYSTEM_ADMIN')) {
      await this.audit.append(context, {
        action: 'SPACE_CREATE_FOR_OWNER',
        resourceType: 'KNOWLEDGE_SPACE',
        result: 'DENIED',
        reason: 'only system admin can choose another owner',
      });
      throw new ApplicationError('ACCESS_DENIED', 403, '只有系统管理员可以指定其他负责人');
    }

    const space = await this.repository.create(context, { ...request, ownerUserId });
    await this.authorization.invalidate();
    await this.audit.append(context, {
      action: 'SPACE_CREATE',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: space.id,
      result: 'SUCCESS',
    });
    return space;
  }

  /** Repository 负责按 AccessContext 返回可见集合，应用层不接受客户端角色过滤。 */
  public async list(
    context: AccessContext,
    query: ListKnowledgeSpacesQuery,
  ): Promise<readonly KnowledgeSpace[]> {
    return this.repository.list(context, query);
  }

  public async get(context: AccessContext, spaceId: string): Promise<KnowledgeSpace> {
    await this.authorization.requirePermission(context, spaceId, 'READ');
    const space = await this.repository.findById(context, spaceId);
    if (!space) throw new ApplicationError('NOT_FOUND', 404, '知识空间不存在');
    return space;
  }

  public async update(
    context: AccessContext,
    spaceId: string,
    request: UpdateKnowledgeSpaceRequest,
  ): Promise<KnowledgeSpace> {
    await this.authorization.requirePermission(context, spaceId, 'WRITE');
    const space = await this.repository.update(context, spaceId, request);
    await this.audit.append(context, {
      action: 'SPACE_UPDATE',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: spaceId,
      result: 'SUCCESS',
      metadata: { version: space.version },
    });
    return space;
  }

  public async deactivate(
    context: AccessContext,
    spaceId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<KnowledgeSpace> {
    await this.authorization.requirePermission(context, spaceId, 'ADMIN');
    const space = await this.repository.deactivate(context, spaceId, expectedVersion, reason);
    await this.authorization.invalidate();
    await this.audit.append(context, {
      action: 'SPACE_DEACTIVATE',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: spaceId,
      result: 'SUCCESS',
      reason,
    });
    return space;
  }

  public async listGrants(context: AccessContext, spaceId: string): Promise<readonly SpaceGrant[]> {
    await this.authorization.requirePermission(context, spaceId, 'ADMIN');
    return this.repository.listGrants(context, spaceId);
  }

  public async upsertGrant(
    context: AccessContext,
    spaceId: string,
    request: UpsertSpaceGrantRequest,
  ): Promise<SpaceGrant> {
    await this.authorization.requirePermission(context, spaceId, 'ADMIN');
    const grant = await this.repository.upsertGrant(context, spaceId, request);
    await this.authorization.invalidate();
    await this.audit.append(context, {
      action: 'SPACE_GRANT_UPSERT',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: spaceId,
      result: 'SUCCESS',
      reason: request.reason,
      metadata: { subjectType: request.subjectType, subjectId: request.subjectId },
    });
    return grant;
  }

  public async revokeGrant(
    context: AccessContext,
    spaceId: string,
    grantId: string,
    request: RevokeSpaceGrantRequest,
  ): Promise<void> {
    await this.authorization.requirePermission(context, spaceId, 'ADMIN');
    await this.repository.revokeGrant(context, spaceId, grantId, request.reason);
    await this.authorization.invalidate();
    await this.audit.append(context, {
      action: 'SPACE_GRANT_REVOKE',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: spaceId,
      result: 'SUCCESS',
      reason: request.reason,
      metadata: { grantId },
    });
  }

  public async listPolicyVersions(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly KnowledgeSpacePolicyVersion[]> {
    await this.authorization.requirePermission(context, spaceId, 'ADMIN');
    return this.repository.listPolicyVersions(context, spaceId);
  }
}
