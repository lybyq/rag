/**
 * M07 PostgreSQL Run 输入加载与候选批量回源 Adapter。
 *
 * Milvus 只给出 vectorId/文档主键/分数；本 Adapter 用单条集合查询取回 Chunk 正文，并再次验证
 * Run 所有者、当前允许空间、Manifest 版本与成员、文档/版本状态、发布时间和生效窗口。
 * 所有值均通过 pg 参数绑定，调用方没有提交 SQL 片段的入口。
 *
 * @requirement RET-007
 * @requirement RET-012
 * @requirement RET-013
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type HydrateRetrievalCandidatesCommand,
  type HydrateRetrievalCandidatesResult,
  type RetrievalRunInput,
  type RetrievalSourceRepository,
} from '@rag/application';
import {
  ExactLiteralKindSchema,
  RagRunSchema,
  RetrievalCandidateSchema,
  type RagRun,
  type RetrievalEntity,
} from '@rag/contracts';
import type { AccessContext } from '@rag/application';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface RunInputRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly user_message_id: string;
  readonly assistant_message_id: string | null;
  readonly status: RagRun['status'];
  readonly optimistic_version: string | number;
  readonly snapshot: RagRun['snapshot'];
  readonly deadline_at: Date;
  readonly event_expires_at: Date;
  readonly cancel_requested_at: Date | null;
  readonly failure_code: string | null;
  readonly public_message: string;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly updated_at: Date;
  readonly content_storage: 'AES_256_GCM' | 'REDACTED' | 'PLAIN';
  readonly content_value: string;
  readonly content_iv: string | null;
  readonly content_auth_tag: string | null;
  readonly content_sha256: string;
  readonly confirmed_entities: unknown;
}

interface HydratedRow {
  readonly vector_id: string;
  readonly chunk_id: string;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly content_revision: number;
  readonly ordinal: number;
  readonly title: string;
  readonly heading_path: unknown;
  readonly display_content: string;
  readonly source_locations: unknown;
  readonly published_at: Date;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

/** PostgreSQL M07 来源事实实现。 */
@Injectable()
export class PostgresRetrievalRepository implements RetrievalSourceRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 只允许 Run owner 取得密文问题与冻结快照；密文解密仍由 Application 的 Protector 完成。 */
  public async loadRunInput(context: AccessContext, runId: string): Promise<RetrievalRunInput> {
    const result = await this.pool.query<RunInputRow>(
      `SELECT run.id, run.conversation_id, run.user_message_id, run.assistant_message_id,
              run.status, run.optimistic_version, run.snapshot, run.deadline_at,
              run.event_expires_at, run.cancel_requested_at, run.failure_code,
              run.public_message, run.created_at, run.started_at, run.completed_at, run.updated_at,
              message.content_storage, message.content_value, message.content_iv,
              message.content_auth_tag, message.content_sha256, state.confirmed_entities
         FROM rag_runs run
         JOIN conversation_messages message ON message.id = run.user_message_id
         JOIN conversation_states state ON state.conversation_id = run.conversation_id
        WHERE run.id = $1 AND run.owner_user_id = $2`,
      [runId, context.user.userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('NOT_FOUND', 404, 'Run 不存在或无权访问');
    return {
      run: mapRun(row),
      protectedQuestion: {
        storage: row.content_storage,
        value: row.content_value,
        ...(row.content_iv ? { iv: row.content_iv } : {}),
        ...(row.content_auth_tag ? { authTag: row.content_auth_tag } : {}),
        sha256: row.content_sha256,
      },
      historyEntities: parseHistoryEntities(row.confirmed_entities),
    };
  }

  /**
   * 一次 SQL 批量回源全部候选，避免 N+1；任何 JOIN 或时态条件失败都会让候选从结果中消失。
   * 返回顺序随后按输入 RRF 顺序恢复，数据库执行计划不会改变相关性次序。
   */
  public async hydrateAndRecheck(
    context: AccessContext,
    command: HydrateRetrievalCandidatesCommand,
  ): Promise<HydrateRetrievalCandidatesResult> {
    if (command.candidates.length === 0) return { candidates: [], removedByReason: {} };
    const allowedSpaces = [...new Set(command.currentlyAllowedSpaceIds)];
    if (allowedSpaces.length === 0) {
      return {
        candidates: [],
        removedByReason: { ACCESS_DENIED: command.candidates.length },
      };
    }
    const requested = command.candidates.map((candidate) => ({
      vector_id: candidate.vectorId,
      manifest_id: candidate.manifestId,
      space_id: candidate.spaceId,
    }));
    const manifests = command.manifests.map((manifest) => ({
      manifest_id: manifest.manifestId,
      manifest_version: manifest.manifestVersion,
      embedding_profile_id: manifest.embeddingProfileId,
    }));
    const result = await this.pool.query<HydratedRow>(
      `WITH requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS item(vector_id text, manifest_id uuid, space_id uuid)
       ), expected_manifest AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS item(manifest_id uuid, manifest_version integer, embedding_profile_id text)
       )
       SELECT requested.vector_id, chunk.id AS chunk_id, document.id AS document_id,
              version.id AS document_version_id, chunk.content_revision, chunk.ordinal,
              document.title, chunk.heading_path, chunk.display_content, chunk.source_locations,
              document.published_at, document.effective_from, document.effective_to
         FROM requested
         JOIN expected_manifest expected ON expected.manifest_id = requested.manifest_id
         JOIN space_manifests manifest
           ON manifest.id = requested.manifest_id
          AND manifest.space_id = requested.space_id
          AND manifest.version = expected.manifest_version
          AND manifest.embedding_profile_id = expected.embedding_profile_id
          AND manifest.status IN ('ACTIVE','SUPERSEDED','VERIFIED')
         JOIN knowledge_spaces space
           ON space.id = manifest.space_id AND space.status = 'ACTIVE'
         JOIN chunk_embedding_refs reference
           ON reference.manifest_id = manifest.id
          AND reference.vector_id::text = requested.vector_id
         JOIN knowledge_chunks chunk
           ON chunk.id = reference.chunk_id AND chunk.eligible_for_index = true
         JOIN document_versions version
           ON version.id = chunk.document_version_id AND version.status = 'SUCCEEDED'
         JOIN documents document
           ON document.id = version.document_id
          AND document.space_id = requested.space_id
          AND document.status = 'ACTIVE'
         JOIN manifest_document_members member
           ON member.manifest_id = manifest.id
          AND member.document_id = document.id
          AND member.document_version_id = version.id
          AND member.content_revision = chunk.content_revision
        WHERE requested.space_id = ANY($3::uuid[])
          AND (
            $5::boolean OR EXISTS (
              SELECT 1
                FROM resource_acl acl
               WHERE acl.resource_id = requested.space_id
                 AND (
                   (acl.subject_type = 'USER' AND acl.subject_id = $6)
                   OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($7::text[]))
                 )
                 AND acl.permissions && ARRAY['READ','WRITE','REVIEW','ADMIN']::text[]
            )
          )
          AND document.published_at IS NOT NULL
          AND document.published_at <= $4::timestamptz
          AND document.effective_from IS NOT NULL
          AND document.effective_from <= $4::timestamptz
          AND (document.effective_to IS NULL OR document.effective_to > $4::timestamptz)`,
      [
        JSON.stringify(requested),
        JSON.stringify(manifests),
        allowedSpaces,
        command.filter.asOf,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    const rows = new Map(result.rows.map((row) => [row.vector_id, row]));
    const candidates = command.candidates.flatMap((candidate) => {
      const row = rows.get(candidate.vectorId);
      if (!row) return [];
      return [
        RetrievalCandidateSchema.parse({
          ...candidate,
          chunkId: row.chunk_id,
          documentVersionId: row.document_version_id,
          contentRevision: row.content_revision,
          ordinal: row.ordinal,
          title: row.title,
          headingPath: stringArray(row.heading_path),
          displayContent: row.display_content,
          sourceLocations: unknownArray(row.source_locations),
          publishedAt: row.published_at.toISOString(),
          effectiveFrom: row.effective_from.toISOString(),
          effectiveTo: row.effective_to?.toISOString() ?? null,
        }),
      ];
    });
    const removed = command.candidates.length - candidates.length;
    return {
      candidates,
      removedByReason: removed > 0 ? { SOURCE_RECHECK_FAILED: removed } : {},
    };
  }
}

function mapRun(row: RunInputRow): RagRun {
  return RagRunSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    optimisticVersion: Number(row.optimistic_version),
    snapshot: row.snapshot,
    deadlineAt: row.deadline_at.toISOString(),
    eventExpiresAt: row.event_expires_at.toISOString(),
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    failureCode: row.failure_code,
    publicMessage: row.public_message,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  });
}

function parseHistoryEntities(value: unknown): readonly RetrievalEntity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const separator = item.indexOf(':');
    if (separator <= 0) return [];
    const kind = ExactLiteralKindSchema.safeParse(item.slice(0, separator));
    const entityValue = item.slice(separator + 1).trim();
    return kind.success && entityValue
      ? [{ kind: kind.data, value: entityValue, source: 'HISTORY' as const }]
      : [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
