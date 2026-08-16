/** PostgreSQL 审计 Adapter；只接受应用层已脱敏的结构化事件。 */
import { Inject, Injectable } from '@nestjs/common';
import type { AccessContext, SecurityAuditEvent, SecurityAuditPort } from '@rag/application';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

/** 即使调用者误传，也从 metadata 中移除高风险字段名。 */
function sanitizeMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !/(token|secret|password|authorization|cookie|signature|header)/i.test(key),
    ),
  );
}

@Injectable()
export class PostgresSecurityAuditAdapter implements SecurityAuditPort {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  public async append(context: AccessContext, event: SecurityAuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (
         actor_user_id, actor_roles, authz_version, action, resource_type, resource_id,
         result, reason, metadata, request_id, trace_id
       ) VALUES ($1, $2::text[], $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        context.user.userId,
        [...context.user.roles],
        context.user.authzVersion,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.result,
        event.reason ?? null,
        JSON.stringify(sanitizeMetadata(event.metadata)),
        context.requestId,
        context.traceId ?? null,
      ],
    );
  }

  public async appendAuthenticationDenied(
    event: SecurityAuditEvent & { readonly requestId: string },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (
         actor_user_id, actor_roles, authz_version, action, resource_type, resource_id,
         result, reason, metadata, request_id
       ) VALUES (NULL, ARRAY[]::text[], NULL, $1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.result,
        event.reason ?? null,
        JSON.stringify(sanitizeMetadata(event.metadata)),
        event.requestId,
      ],
    );
  }
}
