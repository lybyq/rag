-- 查询规划与混合检索：混合检索回源字段、可直接批量关联的 vector_id，以及旧 Run 的检索参数快照回填。
-- PostgreSQL 继续作为正文、版本、Manifest 成员和生效时间的最终事实源。
-- reviewed-destructive-change: vector_id 已在同一事务回填并验证后才收紧约束。
-- migration-phase: contract

ALTER TABLE documents
  ADD COLUMN published_at timestamptz,
  ADD COLUMN effective_from timestamptz,
  ADD COLUMN effective_to timestamptz,
  ADD CONSTRAINT ck_documents_effective_window CHECK (
    effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from
  );

-- 旧数据在 查询规划与混合检索 上线前已经通过既有发布链路可见；以创建时间保守回填。
-- 新文档在 索引构建与发布 原子发布事务中写入这两个时间；发布前保持 NULL，天然不能通过 查询规划与混合检索 回源复核。
UPDATE documents
   SET published_at = COALESCE(published_at, created_at),
       effective_from = COALESCE(effective_from, created_at);

CREATE INDEX idx_documents_retrieval_window
  ON documents (space_id, status, published_at, effective_from, effective_to);

ALTER TABLE chunk_embedding_refs ADD COLUMN vector_id char(64);

-- vector_id 算法与 IndexingService 一致：manifestId:chunkId:embeddingProfileId 的 SHA-256。
UPDATE chunk_embedding_refs reference
   SET vector_id = encode(
     digest(
       reference.manifest_id::text || ':' || reference.chunk_id || ':' || manifest.embedding_profile_id,
       'sha256'
     ),
     'hex'
   )
  FROM space_manifests manifest
 WHERE manifest.id = reference.manifest_id;

ALTER TABLE chunk_embedding_refs
  ALTER COLUMN vector_id SET NOT NULL,
  ADD CONSTRAINT ck_chunk_embedding_refs_vector_id CHECK (vector_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT uq_chunk_embedding_refs_vector_id UNIQUE (vector_id);

CREATE INDEX idx_chunk_embedding_refs_batch_hydrate
  ON chunk_embedding_refs (manifest_id, vector_id);

-- 会话运行与事件 已创建但尚未执行的 Run 也必须冻结同一套 查询规划与混合检索 参数，避免新代码解析旧快照失败。
UPDATE rag_runs
   SET snapshot = jsonb_set(
     snapshot,
     '{retrieval}',
     '{"profileId":"hybrid-medium-v1","initialTopK":40,"finalTopK":12,"rrfK":60,"denseWeight":0.65,"sparseWeight":0.35,"maxPerDocument":3,"maxPerSection":2,"minimumResults":3,"maxRounds":2}'::jsonb,
     true
   )
 WHERE NOT (snapshot ? 'retrieval');

COMMENT ON COLUMN chunk_embedding_refs.vector_id IS
  '查询规划与混合检索 批量 PG 回源键；Milvus 只返回该键，正文仍从本表关联 knowledge_chunks 读取。';
COMMENT ON COLUMN documents.effective_from IS
  '文档业务生效时间；检索时使用 Run 的 asOf 复核，避免返回尚未生效版本。';
