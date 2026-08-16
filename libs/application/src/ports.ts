/**
 * M01 应用层端口。
 * 端口只描述业务需要，不暴露 SQL、Redis、NestJS 或 HTTP 细节。
 */
import type {
  CreateKnowledgeSpaceRequest,
  KnowledgeSpace,
  KnowledgeSpacePolicyVersion,
  ListKnowledgeSpacesQuery,
  SpaceGrant,
  SpacePermission,
  UpdateKnowledgeSpaceRequest,
  UpsertSpaceGrantRequest,
  UserContext,
} from '@rag/contracts';

/** 一次 Repository 调用必须携带的显式访问上下文。 */
export interface AccessContext {
  readonly user: UserContext;
  readonly requestId: string;
  readonly traceId?: string;
}

/** 后续资源模块复用的资源类别；每项都必须重新反查所属空间。 */
export type ProtectedResourceKind =
  | 'DOCUMENT'
  | 'CITATION'
  | 'HISTORY_MESSAGE'
  | 'RETRIEVAL_CANDIDATE'
  | 'EXPORT';

/** 创建记录时由应用层补齐可信 owner 和时间语义。 */
export interface CreateKnowledgeSpaceCommand extends CreateKnowledgeSpaceRequest {
  readonly ownerUserId: string;
}

/** 知识空间事实源端口；所有方法显式接收 AccessContext。 */
export interface KnowledgeSpaceRepository {
  create(context: AccessContext, command: CreateKnowledgeSpaceCommand): Promise<KnowledgeSpace>;
  list(context: AccessContext, query: ListKnowledgeSpacesQuery): Promise<readonly KnowledgeSpace[]>;
  findById(context: AccessContext, spaceId: string): Promise<KnowledgeSpace | undefined>;
  update(
    context: AccessContext,
    spaceId: string,
    command: UpdateKnowledgeSpaceRequest,
  ): Promise<KnowledgeSpace>;
  deactivate(
    context: AccessContext,
    spaceId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<KnowledgeSpace>;
  listGrants(context: AccessContext, spaceId: string): Promise<readonly SpaceGrant[]>;
  upsertGrant(
    context: AccessContext,
    spaceId: string,
    command: UpsertSpaceGrantRequest,
  ): Promise<SpaceGrant>;
  revokeGrant(
    context: AccessContext,
    spaceId: string,
    grantId: string,
    reason: string,
  ): Promise<void>;
  listPolicyVersions(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly KnowledgeSpacePolicyVersion[]>;
  resolvePermissions(context: AccessContext, spaceId: string): Promise<readonly SpacePermission[]>;
  listAccessibleSpaceIds(context: AccessContext): Promise<readonly string[]>;
  resolveResourceSpaceId(
    context: AccessContext,
    kind: ProtectedResourceKind,
    resourceId: string,
  ): Promise<string | undefined>;
}

/** 授权缓存只缓存服务端计算结果，不缓存客户端 requestedSpaceIds。 */
export interface AuthorizationCachePort {
  get(key: string): Promise<readonly SpacePermission[] | undefined>;
  set(key: string, permissions: readonly SpacePermission[], ttlSeconds: number): Promise<void>;
  invalidateAll(): Promise<void>;
}

export type AuditResult = 'SUCCESS' | 'DENIED' | 'FAILURE';

/** 审计事件不包含 Token、原始认证 Header 或共享密钥。 */
export interface SecurityAuditEvent {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly result: AuditResult;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** 已认证业务操作的审计端口。 */
export interface SecurityAuditPort {
  append(context: AccessContext, event: SecurityAuditEvent): Promise<void>;
  appendAuthenticationDenied(
    event: SecurityAuditEvent & { readonly requestId: string },
  ): Promise<void>;
}

/** 依赖注入 Token 使用 Symbol，避免字符串 Token 冲突。 */
export const KNOWLEDGE_SPACE_REPOSITORY = Symbol('KNOWLEDGE_SPACE_REPOSITORY');
export const AUTHORIZATION_CACHE = Symbol('AUTHORIZATION_CACHE');
export const SECURITY_AUDIT = Symbol('SECURITY_AUDIT');
export const AUTHORIZATION_VERSION_PROVIDER = Symbol('AUTHORIZATION_VERSION_PROVIDER');
