/**
 * 知识空间 PostgreSQL Repository。
 * 应用层会鉴权一次，本 Adapter 仍在写 SQL 中再次使用 AccessContext，形成纵深防御。
 *
 * @requirement AUTH-007
 * @requirement AUTH-008
 * @requirement AUTH-010
 * @requirement AUTH-012
 * @requirement IDX-012
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessContext,
  CreateKnowledgeSpaceCommand,
  KnowledgeSpaceRepository,
  ProtectedResourceKind,
} from '@rag/application';
import { ApplicationError } from '@rag/application';
import {
  KnowledgeSpacePolicyVersionSchema,
  SpaceGrantSchema,
  SpacePermissionSchema,
  type KnowledgeSpace,
  type KnowledgeSpacePolicyVersion,
  type ListKnowledgeSpacesQuery,
  type SpaceGrant,
  type SpacePermission,
  type UpdateKnowledgeSpaceRequest,
  type UpsertSpaceGrantRequest,
} from '@rag/contracts';
import { expandPermissions } from '@rag/domain';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface SpaceRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  policy_version: number;
  document_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GrantRow {
  id: string;
  resource_id: string;
  subject_type: 'USER' | 'ROLE';
  subject_id: string;
  permissions: string[];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PolicyRow {
  space_id: string;
  version: number;
  grants: unknown;
  changed_by: string;
  change_reason: string;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapGrant(row: GrantRow): SpaceGrant {
  return SpaceGrantSchema.parse({
    id: row.id,
    spaceId: row.resource_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    permissions: row.permissions,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function mapSpace(row: SpaceRow, permissions: readonly SpacePermission[]): KnowledgeSpace {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    status: row.status,
    version: row.version,
    policyVersion: row.policy_version,
    documentCount: row.document_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    effectivePermissions: [...permissions],
  };
}

const grantColumns = `
  id, resource_id, subject_type, subject_id, permissions, created_by, created_at, updated_at
`;

@Injectable()
export class PostgresKnowledgeSpaceRepository implements KnowledgeSpaceRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  public async create(
    context: AccessContext,
    command: CreateKnowledgeSpaceCommand,
  ): Promise<KnowledgeSpace> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<SpaceRow>(
        `INSERT INTO knowledge_spaces (code, name, description, owner_user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [command.code, command.name, command.description ?? null, command.ownerUserId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('知识空间创建未返回记录');

      const grantResult = await client.query<GrantRow>(
        `INSERT INTO resource_acl (
           resource_type, resource_id, subject_type, subject_id, permissions, created_by
         ) VALUES ('KNOWLEDGE_SPACE', $1, 'USER', $2, $3::text[], $4)
         RETURNING ${grantColumns}`,
        [row.id, command.ownerUserId, ['READ', 'WRITE', 'REVIEW', 'ADMIN'], context.user.userId],
      );
      const ownerGrant = grantResult.rows[0];
      if (!ownerGrant) throw new Error('Owner ACL 创建未返回记录');

      await client.query(
        `INSERT INTO knowledge_space_policies (
           space_id, version, grants, changed_by, change_reason
         ) VALUES ($1, 1, $2::jsonb, $3, 'knowledge space created')`,
        [row.id, JSON.stringify([mapGrant(ownerGrant)]), context.user.userId],
      );
      await this.incrementAuthorizationVersion(client);
      await client.query('COMMIT');
      return mapSpace(row, ['READ', 'WRITE', 'REVIEW', 'ADMIN']);
    } catch (error) {
      await client.query('ROLLBACK');
      if (this.isUniqueViolation(error)) {
        throw new ApplicationError('DUPLICATE_RESOURCE', 409, '知识空间编码已存在');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async list(
    context: AccessContext,
    query: ListKnowledgeSpacesQuery,
  ): Promise<readonly KnowledgeSpace[]> {
    const result = await this.pool.query<SpaceRow>(
      `SELECT ks.*
         FROM knowledge_spaces ks
        WHERE ($1::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = ks.id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $2)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($3::text[])))
        ))
          AND ($4::text IS NULL OR ks.status = $4)
          AND ($5::text IS NULL OR ks.name ILIKE '%' || $5 || '%' OR ks.code ILIKE '%' || $5 || '%')
        ORDER BY ks.updated_at DESC, ks.id`,
      [
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
        query.status ?? null,
        query.search ?? null,
      ],
    );
    const permissionsBySpace = await this.loadPermissionsForSpaces(
      context,
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => mapSpace(row, permissionsBySpace.get(row.id) ?? []));
  }

  public async findById(
    context: AccessContext,
    spaceId: string,
  ): Promise<KnowledgeSpace | undefined> {
    const result = await this.pool.query<SpaceRow>(
      `SELECT ks.* FROM knowledge_spaces ks
        WHERE ks.id = $1
          AND ($2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
          ))`,
      [spaceId, this.isSystemAdmin(context), context.user.userId, [...context.user.roles]],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return mapSpace(row, await this.resolvePermissions(context, spaceId));
  }

  public async update(
    context: AccessContext,
    spaceId: string,
    command: UpdateKnowledgeSpaceRequest,
  ): Promise<KnowledgeSpace> {
    const result = await this.pool.query<SpaceRow>(
      `UPDATE knowledge_spaces ks
          SET name = CASE WHEN $4::boolean THEN $5 ELSE name END,
              description = CASE WHEN $6::boolean THEN $7 ELSE description END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $2 AND status = 'ACTIVE'
          AND ($3::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $8)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($9::text[])))
               AND acl.permissions && ARRAY['WRITE', 'ADMIN']::text[]
          ))
      RETURNING *`,
      [
        spaceId,
        command.expectedVersion,
        this.isSystemAdmin(context),
        command.name !== undefined,
        command.name ?? null,
        command.description !== undefined,
        command.description ?? null,
        context.user.userId,
        [...context.user.roles],
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('VERSION_CONFLICT', 409, '空间版本冲突或已停用');
    return mapSpace(row, await this.resolvePermissions(context, spaceId));
  }

  public async deactivate(
    context: AccessContext,
    spaceId: string,
    expectedVersion: number,
  ): Promise<KnowledgeSpace> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<SpaceRow>(
        `UPDATE knowledge_spaces ks
          SET status = 'INACTIVE', version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2
          AND ($3::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $4)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($5::text[])))
               AND 'ADMIN' = ANY(acl.permissions)
          ))
      RETURNING *`,
        [
          spaceId,
          expectedVersion,
          this.isSystemAdmin(context),
          context.user.userId,
          [...context.user.roles],
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ApplicationError('VERSION_CONFLICT', 409, '空间版本冲突或无管理权限');
      }
      await this.incrementAuthorizationVersion(client);
      // 空间废止与状态更新必须同事务落入 Outbox；否则其他实例仍可能使用旧权限/旧检索缓存。
      await this.insertOutbox(
        client,
        `${spaceId}:deactivate:v${row.version}`,
        'index.space.revoked',
        {
          spaceId,
          spaceVersion: row.version,
          reason: 'knowledge space deactivated',
        },
      );
      await this.insertOutbox(
        client,
        `${spaceId}:deactivate:v${row.version}`,
        'cache.invalidate.space',
        {
          spaceId,
          cause: 'SPACE_REVOKED',
        },
      );
      await client.query('COMMIT');
      return mapSpace(row, await this.resolvePermissions(context, spaceId));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listGrants(context: AccessContext, spaceId: string): Promise<readonly SpaceGrant[]> {
    await this.assertDirectPermission(context, spaceId, 'ADMIN');
    return this.loadAllGrants(this.pool, spaceId);
  }

  public async upsertGrant(
    context: AccessContext,
    spaceId: string,
    command: UpsertSpaceGrantRequest,
  ): Promise<SpaceGrant> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertDirectPermission(context, spaceId, 'ADMIN', client, true);
      const result = await client.query<GrantRow>(
        `INSERT INTO resource_acl (
           resource_type, resource_id, subject_type, subject_id, permissions, created_by
         ) VALUES ('KNOWLEDGE_SPACE', $1, $2, $3, $4::text[], $5)
         ON CONFLICT (resource_type, resource_id, subject_type, subject_id)
         DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()
         RETURNING ${grantColumns}`,
        [
          spaceId,
          command.subjectType,
          command.subjectId,
          [...command.permissions],
          context.user.userId,
        ],
      );
      await this.ensureAtLeastOneAdmin(client, spaceId);
      const policyVersion = await this.incrementPolicyVersion(client, spaceId);
      const grants = await this.loadAllGrants(client, spaceId);
      await this.insertPolicySnapshot(
        client,
        spaceId,
        policyVersion,
        grants,
        context,
        command.reason,
      );
      await this.incrementAuthorizationVersion(client);
      await this.insertOutbox(
        client,
        `${spaceId}:policy:v${policyVersion}`,
        'index.authorization.changed',
        {
          spaceId,
          policyVersion,
          subjectType: command.subjectType,
          subjectId: command.subjectId,
        },
      );
      await this.insertOutbox(
        client,
        `${spaceId}:policy:v${policyVersion}`,
        'cache.invalidate.space',
        {
          spaceId,
          policyVersion,
          cause: 'AUTHORIZATION_CHANGED',
        },
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('ACL upsert 未返回记录');
      return mapGrant(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeGrant(
    context: AccessContext,
    spaceId: string,
    grantId: string,
    reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertDirectPermission(context, spaceId, 'ADMIN', client, true);
      const deleted = await client.query(
        'DELETE FROM resource_acl WHERE id = $1 AND resource_id = $2',
        [grantId, spaceId],
      );
      if (deleted.rowCount !== 1) throw new ApplicationError('NOT_FOUND', 404, '授权记录不存在');
      await this.ensureAtLeastOneAdmin(client, spaceId);
      const policyVersion = await this.incrementPolicyVersion(client, spaceId);
      const grants = await this.loadAllGrants(client, spaceId);
      await this.insertPolicySnapshot(client, spaceId, policyVersion, grants, context, reason);
      await this.incrementAuthorizationVersion(client);
      await this.insertOutbox(
        client,
        `${spaceId}:policy:v${policyVersion}`,
        'index.authorization.revoked',
        {
          spaceId,
          policyVersion,
          revokedGrantId: grantId,
          reason,
        },
      );
      await this.insertOutbox(
        client,
        `${spaceId}:policy:v${policyVersion}`,
        'cache.invalidate.space',
        {
          spaceId,
          policyVersion,
          cause: 'AUTHORIZATION_REVOKED',
        },
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listPolicyVersions(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly KnowledgeSpacePolicyVersion[]> {
    await this.assertDirectPermission(context, spaceId, 'ADMIN');
    const result = await this.pool.query<PolicyRow>(
      `SELECT space_id, version, grants, changed_by, change_reason, created_at
         FROM knowledge_space_policies
        WHERE space_id = $1
        ORDER BY version DESC`,
      [spaceId],
    );
    return result.rows.map((row) =>
      KnowledgeSpacePolicyVersionSchema.parse({
        spaceId: row.space_id,
        version: row.version,
        grants: row.grants,
        changedBy: row.changed_by,
        changeReason: row.change_reason,
        createdAt: toIso(row.created_at),
      }),
    );
  }

  public async resolvePermissions(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly SpacePermission[]> {
    if (this.isSystemAdmin(context)) return ['READ', 'WRITE', 'REVIEW', 'ADMIN'];
    const result = await this.pool.query<{ permissions: string[] }>(
      `SELECT permissions FROM resource_acl
        WHERE resource_id = $1
          AND ((subject_type = 'USER' AND subject_id = $2)
            OR (subject_type = 'ROLE' AND subject_id = ANY($3::text[])))`,
      [spaceId, context.user.userId, [...context.user.roles]],
    );
    const permissions = result.rows.flatMap((row) =>
      row.permissions.map((permission) => SpacePermissionSchema.parse(permission)),
    );
    return expandPermissions(permissions);
  }

  public async listAccessibleSpaceIds(context: AccessContext): Promise<readonly string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT ks.id FROM knowledge_spaces ks
        WHERE ks.status = 'ACTIVE'
          AND ($1::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $2)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($3::text[])))
          ))
        ORDER BY ks.id`,
      [this.isSystemAdmin(context), context.user.userId, [...context.user.roles]],
    );
    return result.rows.map((row) => row.id);
  }

  public async resolveResourceSpaceId(
    _context: AccessContext,
    kind: ProtectedResourceKind,
    resourceId: string,
  ): Promise<string | undefined> {
    const result = await this.pool.query<{ space_id: string }>(
      `SELECT space_id FROM protected_resource_spaces
        WHERE resource_type = $1 AND resource_id = $2`,
      [kind, resourceId],
    );
    return result.rows[0]?.space_id;
  }

  private isSystemAdmin(context: AccessContext): boolean {
    return context.user.roles.includes('SYSTEM_ADMIN');
  }

  private async loadPermissionsForSpaces(
    context: AccessContext,
    spaceIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly SpacePermission[]>> {
    if (this.isSystemAdmin(context)) {
      return new Map(spaceIds.map((spaceId) => [spaceId, ['READ', 'WRITE', 'REVIEW', 'ADMIN']]));
    }
    if (spaceIds.length === 0) return new Map();
    const result = await this.pool.query<{ resource_id: string; permissions: string[] }>(
      `SELECT resource_id, permissions FROM resource_acl
        WHERE resource_id = ANY($1::uuid[])
          AND ((subject_type = 'USER' AND subject_id = $2)
            OR (subject_type = 'ROLE' AND subject_id = ANY($3::text[])))`,
      [[...spaceIds], context.user.userId, [...context.user.roles]],
    );
    const direct = new Map<string, SpacePermission[]>();
    for (const row of result.rows) {
      const permissions = direct.get(row.resource_id) ?? [];
      permissions.push(...row.permissions.map((value) => SpacePermissionSchema.parse(value)));
      direct.set(row.resource_id, permissions);
    }
    return new Map(
      [...direct.entries()].map(([spaceId, permissions]) => [
        spaceId,
        expandPermissions(permissions),
      ]),
    );
  }

  private async assertDirectPermission(
    context: AccessContext,
    spaceId: string,
    permission: 'ADMIN',
    queryable: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<void> {
    const result = await queryable.query<{ id: string }>(
      `SELECT ks.id FROM knowledge_spaces ks
        WHERE ks.id = $1
          AND ($2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
               AND $5 = ANY(acl.permissions)
          ))
        ${lock ? 'FOR UPDATE' : ''}`,
      [
        spaceId,
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
        permission,
      ],
    );
    if (!result.rows[0]) throw new ApplicationError('ACCESS_DENIED', 403, '无权管理该知识空间');
  }

  private async loadAllGrants(
    queryable: Pool | PoolClient,
    spaceId: string,
  ): Promise<readonly SpaceGrant[]> {
    const result = await queryable.query<GrantRow>(
      `SELECT ${grantColumns} FROM resource_acl
        WHERE resource_id = $1
        ORDER BY subject_type, subject_id`,
      [spaceId],
    );
    return result.rows.map(mapGrant);
  }

  private async ensureAtLeastOneAdmin(client: PoolClient, spaceId: string): Promise<void> {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM resource_acl
        WHERE resource_id = $1 AND 'ADMIN' = ANY(permissions)`,
      [spaceId],
    );
    if (Number(result.rows[0]?.count ?? 0) < 1) {
      throw new ApplicationError('ACCESS_DENIED', 403, '知识空间必须至少保留一个 ADMIN 授权');
    }
  }

  private async incrementPolicyVersion(client: PoolClient, spaceId: string): Promise<number> {
    const result = await client.query<{ policy_version: number }>(
      `UPDATE knowledge_spaces
          SET policy_version = policy_version + 1, updated_at = now()
        WHERE id = $1
      RETURNING policy_version`,
      [spaceId],
    );
    const version = result.rows[0]?.policy_version;
    if (!version) throw new ApplicationError('NOT_FOUND', 404, '知识空间不存在');
    return version;
  }

  private async insertPolicySnapshot(
    client: PoolClient,
    spaceId: string,
    version: number,
    grants: readonly SpaceGrant[],
    context: AccessContext,
    reason: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO knowledge_space_policies (
         space_id, version, grants, changed_by, change_reason
       ) VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [spaceId, version, JSON.stringify(grants), context.user.userId, reason],
    );
  }

  private async incrementAuthorizationVersion(client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE authorization_state SET version = version + 1, updated_at = now()
        WHERE singleton_id = 1`,
    );
  }

  /**
   * 将空间变化写入与业务修改相同的 PostgreSQL 事务。
   * aggregateId 使用业务版本构成幂等键，同一个策略版本重试不会产生两份事件。
   */
  private async insertOutbox(
    client: PoolClient,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('KNOWLEDGE_SPACE', $1, $2, $3::jsonb)`,
      [aggregateId, eventType, JSON.stringify(payload)],
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
