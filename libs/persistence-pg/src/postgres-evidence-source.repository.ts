/**
 * 答案证据 PostgreSQL Adapter。
 *
 * 本文件位于“检索候选 → 证据包”安全边界：它扩展父块、前后相邻块和表头，但每次扩展都
 * 重新校验当前 ACL、知识空间、Manifest 成员、文档版本、content revision 与生效时间。
 * 它不计算置信度、不决定答案路由，也不信任 Milvus 或模型返回的资源主键。
 *
 * @requirement ANS-003
 * @requirement ANS-011
 * @requirement ANS-017
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  AccessContext,
  EvidenceSourceRepository,
  ExpandEvidenceCommand,
  ExpandEvidenceResult,
  ExpandedEvidenceMaterial,
} from '@rag/application';
import type { EvidenceRelation, EvidenceSource } from '@rag/contracts';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface ExpandedEvidenceRow {
  readonly relation: EvidenceRelation;
  readonly origin_candidate_id: string;
  readonly manifest_id: string;
  readonly space_id: string;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly content_revision: number;
  readonly chunk_id: string;
  readonly title: string;
  readonly heading_path: unknown;
  readonly display_content: string;
  readonly source_locations: unknown;
  readonly published_at: Date;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

/** 只通过绑定参数执行扩展与最终来源复核的 PostgreSQL 实现。 */
@Injectable()
export class PostgresEvidenceSourceRepository implements EvidenceSourceRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * 从原始候选扩展结构关系。`valid_origin` 是唯一入口，后续关系必须属于同一加工 Run、
   * 文档版本和 content revision，因此旧版本或跨文档伪造关系无法进入结果。
   */
  public async expandAndRecheck(
    context: AccessContext,
    command: ExpandEvidenceCommand,
  ): Promise<ExpandEvidenceResult> {
    if (command.candidates.length === 0) return { materials: [], removedByReason: {} };
    const allowedSpaces = [...new Set(command.currentlyAllowedSpaceIds)];
    if (allowedSpaces.length === 0) {
      return {
        materials: [],
        removedByReason: { ACCESS_DENIED: command.candidates.length },
      };
    }
    const requested = command.candidates.map((candidate, inputOrder) => ({
      input_order: inputOrder,
      origin_candidate_id: candidate.chunkId,
      chunk_id: candidate.chunkId,
      manifest_id: candidate.manifestId,
      space_id: candidate.spaceId,
      document_id: candidate.documentId,
      document_version_id: candidate.documentVersionId,
      content_revision: candidate.contentRevision,
    }));
    const manifests = command.manifests.map((manifest) => ({
      manifest_id: manifest.manifestId,
      manifest_version: manifest.manifestVersion,
      embedding_profile_id: manifest.embeddingProfileId,
    }));
    const result = await this.pool.query<ExpandedEvidenceRow>(
      `WITH requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           input_order integer, origin_candidate_id text, chunk_id text, manifest_id uuid,
           space_id uuid, document_id uuid, document_version_id uuid, content_revision integer
         )
       ), expected_manifest AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS item(manifest_id uuid, manifest_version integer, embedding_profile_id text)
       ), valid_origin AS (
         SELECT requested.*, document.title, document.published_at,
                document.effective_from, document.effective_to,
                chunk.processing_run_id, chunk.heading_path, chunk.display_content,
                chunk.source_locations
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
           JOIN knowledge_chunks chunk
             ON chunk.id = requested.chunk_id
            AND chunk.document_version_id = requested.document_version_id
            AND chunk.content_revision = requested.content_revision
           JOIN document_versions version
             ON version.id = requested.document_version_id AND version.status = 'SUCCEEDED'
           JOIN documents document
             ON document.id = requested.document_id
            AND document.id = version.document_id
            AND document.space_id = requested.space_id
            AND document.status = 'ACTIVE'
           JOIN manifest_document_members member
             ON member.manifest_id = manifest.id
            AND member.document_id = document.id
            AND member.document_version_id = version.id
            AND member.content_revision = chunk.content_revision
          WHERE requested.space_id = ANY($3::uuid[])
            AND ($5::boolean OR EXISTS (
              SELECT 1 FROM resource_acl acl
               WHERE acl.resource_id = requested.space_id
                 AND ((acl.subject_type = 'USER' AND acl.subject_id = $6)
                   OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($7::text[])))
                 AND acl.permissions && ARRAY['READ','WRITE','REVIEW','ADMIN']::text[]
            ))
            AND document.published_at IS NOT NULL AND document.published_at <= $4::timestamptz
            AND document.effective_from IS NOT NULL AND document.effective_from <= $4::timestamptz
            AND (document.effective_to IS NULL OR document.effective_to > $4::timestamptz)
       ), expanded_chunks AS (
         SELECT origin.input_order, 'SELF'::text AS relation, origin.origin_candidate_id,
                origin.manifest_id, origin.space_id, origin.document_id,
                origin.document_version_id, origin.content_revision, origin.chunk_id,
                origin.title, origin.heading_path, origin.display_content,
                origin.source_locations, origin.published_at, origin.effective_from,
                origin.effective_to, 0 AS relation_order
           FROM valid_origin origin
         UNION ALL
         SELECT origin.input_order,
                CASE relation.relation_type
                  WHEN 'PARENT_CHILD' THEN 'PARENT'
                  WHEN 'PREVIOUS' THEN 'PREVIOUS'
                  WHEN 'NEXT' THEN 'NEXT'
                END AS relation,
                origin.origin_candidate_id, origin.manifest_id, origin.space_id,
                origin.document_id, origin.document_version_id, origin.content_revision,
                related.id AS chunk_id, origin.title, related.heading_path,
                related.display_content, related.source_locations, origin.published_at,
                origin.effective_from, origin.effective_to,
                CASE relation.relation_type WHEN 'PARENT_CHILD' THEN 1 WHEN 'PREVIOUS' THEN 2 ELSE 3 END
           FROM valid_origin origin
           JOIN chunk_relations relation
             ON relation.from_chunk_id = origin.chunk_id
            AND relation.relation_type IN ('PARENT_CHILD','PREVIOUS','NEXT')
           JOIN knowledge_chunks related
             ON related.id = relation.to_chunk_id
            AND related.processing_run_id = origin.processing_run_id
            AND related.document_version_id = origin.document_version_id
            AND related.content_revision = origin.content_revision
       ), expanded_table_headers AS (
         SELECT origin.input_order, 'TABLE_HEADER'::text AS relation,
                origin.origin_candidate_id, origin.manifest_id, origin.space_id,
                origin.document_id, origin.document_version_id, origin.content_revision,
                origin.chunk_id, origin.title, origin.heading_path,
                block.text_content AS display_content,
                jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                  'blockId', block.id, 'pageNo', block.page_no,
                  'sheetName', block.sheet_name, 'slideNo', block.slide_no
                ))) AS source_locations,
                origin.published_at, origin.effective_from, origin.effective_to,
                4 AS relation_order
           FROM valid_origin origin
           JOIN chunk_relations relation
             ON relation.from_chunk_id = origin.chunk_id
            AND relation.relation_type = 'TABLE_HEADER'
           JOIN document_blocks block
             ON block.id = relation.to_block_id
            AND block.document_version_id = origin.document_version_id
            AND block.content_revision = origin.content_revision
          WHERE length(trim(block.text_content)) > 0
       )
       SELECT relation, origin_candidate_id, manifest_id, space_id, document_id,
              document_version_id, content_revision, chunk_id, title, heading_path,
              display_content, source_locations, published_at, effective_from, effective_to
         FROM (
           SELECT * FROM expanded_chunks
           UNION ALL
           SELECT * FROM expanded_table_headers
         ) evidence
        ORDER BY input_order, relation_order, chunk_id`,
      [
        JSON.stringify(requested),
        JSON.stringify(manifests),
        allowedSpaces,
        command.asOf,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    const returnedOrigins = new Set(result.rows.map((row) => row.origin_candidate_id));
    const removed = command.candidates.filter(
      (candidate) => !returnedOrigins.has(candidate.chunkId),
    ).length;
    return {
      materials: result.rows.map(mapMaterial),
      removedByReason: removed > 0 ? { SOURCE_RECHECK_FAILED: removed } : {},
    };
  }

  /**
   * 发布答案前按 sourceId 对所有引用做最后一次复核。返回值只含仍然有效的不透明 sourceId，
   * Validator 会阻断被撤权、过期、换版或伪造的引用。
   */
  public async revalidateSources(
    context: AccessContext,
    sources: readonly EvidenceSource[],
    asOf: Date,
  ): Promise<readonly string[]> {
    if (sources.length === 0) return [];
    const requested = sources.map((source) => ({
      source_id: source.sourceId,
      manifest_id: source.manifestId,
      space_id: source.spaceId,
      document_id: source.documentId,
      document_version_id: source.documentVersionId,
      content_revision: source.contentRevision,
      chunk_id: source.chunkId,
    }));
    const result = await this.pool.query<{ source_id: string }>(
      `WITH requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           source_id uuid, manifest_id uuid, space_id uuid, document_id uuid,
           document_version_id uuid, content_revision integer, chunk_id text
         )
       )
       SELECT requested.source_id
         FROM requested
         JOIN space_manifests manifest
           ON manifest.id = requested.manifest_id
          AND manifest.space_id = requested.space_id
          AND manifest.status IN ('ACTIVE','SUPERSEDED','VERIFIED')
         JOIN knowledge_spaces space ON space.id = requested.space_id AND space.status = 'ACTIVE'
         JOIN knowledge_chunks chunk
           ON chunk.id = requested.chunk_id
          AND chunk.document_version_id = requested.document_version_id
          AND chunk.content_revision = requested.content_revision
         JOIN document_versions version
           ON version.id = requested.document_version_id AND version.status = 'SUCCEEDED'
         JOIN documents document
           ON document.id = requested.document_id
          AND document.id = version.document_id
          AND document.space_id = requested.space_id
          AND document.status = 'ACTIVE'
         JOIN manifest_document_members member
           ON member.manifest_id = requested.manifest_id
          AND member.document_id = requested.document_id
          AND member.document_version_id = requested.document_version_id
          AND member.content_revision = requested.content_revision
        WHERE ($3::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = requested.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $4)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($5::text[])))
             AND acl.permissions && ARRAY['READ','WRITE','REVIEW','ADMIN']::text[]
        ))
          AND document.published_at IS NOT NULL AND document.published_at <= $2::timestamptz
          AND document.effective_from IS NOT NULL AND document.effective_from <= $2::timestamptz
          AND (document.effective_to IS NULL OR document.effective_to > $2::timestamptz)`,
      [
        JSON.stringify(requested),
        asOf,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    return result.rows.map((row) => row.source_id);
  }
}

function mapMaterial(row: ExpandedEvidenceRow): ExpandedEvidenceMaterial {
  return {
    relation: row.relation,
    originCandidateId: row.origin_candidate_id,
    manifestId: row.manifest_id,
    spaceId: row.space_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    contentRevision: Number(row.content_revision),
    chunkId: row.chunk_id,
    title: row.title,
    headingPath: stringArray(row.heading_path),
    content: row.display_content,
    sourceLocations: unknownArray(row.source_locations),
    publishedAt: row.published_at.toISOString(),
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
