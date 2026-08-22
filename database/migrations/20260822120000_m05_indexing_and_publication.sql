-- M05：Embedding 事实、Profile Collection Registry、不可见构建、Manifest 原子发布和异步维护。
-- PostgreSQL 是可见性唯一事实源；Milvus 中出现记录不代表它已经在线发布。

ALTER TABLE protected_resource_spaces
  DROP CONSTRAINT protected_resource_spaces_resource_type_check;

ALTER TABLE protected_resource_spaces
  ADD CONSTRAINT protected_resource_spaces_resource_type_check CHECK (
    resource_type IN (
      'DOCUMENT', 'KNOWLEDGE_RUN', 'INDEX_RUN', 'SPACE_MANIFEST',
      'CITATION', 'HISTORY_MESSAGE', 'RETRIEVAL_CANDIDATE', 'EXPORT'
    )
  );

-- IDX-002/006：Profile 不兼容字段组成 compatibility_sha256；不同摘要不得复用 Collection。
CREATE TABLE embedding_collection_registry (
  embedding_profile_id varchar(100) PRIMARY KEY,
  compatibility_sha256 char(64) NOT NULL UNIQUE CHECK (compatibility_sha256 ~ '^[a-f0-9]{64}$'),
  provider_profile varchar(40) NOT NULL CHECK (
    provider_profile IN (
      'test', 'external-dev', 'external-ci', 'intranet-staging', 'intranet-production'
    )
  ),
  model_id varchar(160) NOT NULL,
  model_revision varchar(100) NOT NULL,
  tokenizer_revision varchar(100) NOT NULL,
  dense_dimension integer NOT NULL CHECK (dense_dimension > 0),
  normalize_dense boolean NOT NULL,
  sparse_format_version varchar(100),
  document_template_version varchar(100) NOT NULL,
  query_template_version varchar(100) NOT NULL,
  collection_name varchar(255) NOT NULL UNIQUE CHECK (collection_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
  alias_name varchar(255) NOT NULL UNIQUE CHECK (alias_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- IDX-008/009：Manifest 在 BUILDING/VERIFIED 阶段不能被普通检索读取。
CREATE TABLE space_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  version integer NOT NULL CHECK (version > 0),
  status varchar(16) NOT NULL CHECK (
    status IN ('BUILDING', 'VERIFIED', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'FAILED')
  ),
  provider_profile varchar(40) NOT NULL CHECK (
    provider_profile IN (
      'test', 'external-dev', 'external-ci', 'intranet-staging', 'intranet-production'
    )
  ),
  embedding_profile_id varchar(100) NOT NULL REFERENCES embedding_collection_registry(embedding_profile_id),
  embedding_model_id varchar(160) NOT NULL,
  embedding_model_revision varchar(100) NOT NULL,
  tokenizer_revision varchar(100) NOT NULL,
  dense_dimension integer NOT NULL CHECK (dense_dimension > 0),
  normalize_dense boolean NOT NULL,
  sparse_format_version varchar(100),
  collection_name varchar(255) NOT NULL,
  expected_vector_count integer NOT NULL DEFAULT 0 CHECK (expected_vector_count >= 0),
  actual_vector_count integer NOT NULL DEFAULT 0 CHECK (actual_vector_count >= 0),
  reconciliation_sha256 char(64) CHECK (
    reconciliation_sha256 IS NULL OR reconciliation_sha256 ~ '^[a-f0-9]{64}$'
  ),
  build_reason varchar(500) NOT NULL DEFAULT 'DOCUMENT_PUBLISH',
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_space_manifest_version UNIQUE (space_id, version)
);

CREATE UNIQUE INDEX uq_space_manifest_active
  ON space_manifests (space_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_space_manifest_history ON space_manifests (space_id, version DESC);
CREATE INDEX idx_space_manifest_maintenance ON space_manifests (status, updated_at);

-- 在线读取先访问 Head，再按 manifest_id 过滤 Milvus；不存在“半个新版本”。
CREATE TABLE space_manifest_heads (
  space_id uuid PRIMARY KEY REFERENCES knowledge_spaces(id),
  active_manifest_id uuid NOT NULL UNIQUE REFERENCES space_manifests(id),
  active_manifest_version integer NOT NULL CHECK (active_manifest_version > 0),
  optimistic_version integer NOT NULL DEFAULT 1 CHECK (optimistic_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- IDX-005：向量事实按内容 Hash + Profile 复用，来源关系在 chunk_embedding_refs 中独立保存。
CREATE TABLE embedding_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  embedding_profile_id varchar(100) NOT NULL REFERENCES embedding_collection_registry(embedding_profile_id),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  model_id varchar(160) NOT NULL,
  model_revision varchar(100) NOT NULL,
  dense_vector jsonb NOT NULL CHECK (jsonb_typeof(dense_vector) = 'array'),
  sparse_vector jsonb CHECK (sparse_vector IS NULL OR jsonb_typeof(sparse_vector) = 'object'),
  dense_dimension integer NOT NULL CHECK (dense_dimension > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_embedding_fact UNIQUE (embedding_profile_id, content_sha256)
);

CREATE INDEX idx_embedding_facts_profile_created
  ON embedding_facts (embedding_profile_id, created_at DESC);

-- 每个 Job 只有一个 M05 Run；失败重试恢复同一构建快照，重处理则由新 Job 创建新 Run。
CREATE TABLE indexing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id varchar(300) NOT NULL UNIQUE REFERENCES ingestion_jobs(id),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision > 0),
  embedding_revision integer NOT NULL CHECK (embedding_revision > 0),
  provider_profile varchar(40) NOT NULL CHECK (
    provider_profile IN (
      'test', 'external-dev', 'external-ci', 'intranet-staging', 'intranet-production'
    )
  ),
  embedding_profile_id varchar(100) NOT NULL REFERENCES embedding_collection_registry(embedding_profile_id),
  embedding_model_id varchar(160) NOT NULL,
  embedding_model_revision varchar(100) NOT NULL,
  collection_name varchar(255) NOT NULL,
  manifest_id uuid NOT NULL UNIQUE REFERENCES space_manifests(id),
  manifest_version integer NOT NULL CHECK (manifest_version > 0),
  status varchar(16) NOT NULL CHECK (
    status IN ('BUILDING', 'EMBEDDING', 'INDEXING', 'VERIFYING', 'VERIFIED', 'PUBLISHED', 'FAILED', 'CANCELLED')
  ),
  expected_vector_count integer NOT NULL DEFAULT 0 CHECK (expected_vector_count >= 0),
  embedded_count integer NOT NULL DEFAULT 0 CHECK (embedded_count >= 0),
  reused_count integer NOT NULL DEFAULT 0 CHECK (reused_count >= 0),
  indexed_count integer NOT NULL DEFAULT 0 CHECK (indexed_count >= 0),
  failure_code varchar(100),
  failure_message varchar(500),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_indexing_runs_space_created ON indexing_runs (space_id, created_at DESC);
CREATE INDEX idx_indexing_runs_status_updated ON indexing_runs (status, updated_at);

CREATE TABLE manifest_document_members (
  manifest_id uuid NOT NULL REFERENCES space_manifests(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision > 0),
  embedding_revision integer NOT NULL CHECK (embedding_revision > 0),
  vector_count integer NOT NULL DEFAULT 0 CHECK (vector_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_id, document_id),
  CONSTRAINT uq_manifest_document_version UNIQUE (manifest_id, document_version_id)
);

CREATE INDEX idx_manifest_members_version ON manifest_document_members (document_version_id);

CREATE TABLE chunk_embedding_refs (
  indexing_run_id uuid NOT NULL REFERENCES indexing_runs(id),
  manifest_id uuid NOT NULL REFERENCES space_manifests(id),
  chunk_id varchar(180) NOT NULL REFERENCES knowledge_chunks(id),
  embedding_fact_id uuid NOT NULL REFERENCES embedding_facts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (indexing_run_id, chunk_id),
  CONSTRAINT uq_manifest_chunk UNIQUE (manifest_id, chunk_id)
);

CREATE INDEX idx_chunk_embedding_fact ON chunk_embedding_refs (embedding_fact_id);

-- 对账报告不可变；问题以 JSON 存放稳定代码和主键，不包含正文。
CREATE TABLE index_reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indexing_run_id uuid NOT NULL UNIQUE REFERENCES indexing_runs(id),
  manifest_id uuid NOT NULL UNIQUE REFERENCES space_manifests(id),
  expected_count integer NOT NULL CHECK (expected_count >= 0),
  actual_count integer NOT NULL CHECK (actual_count >= 0),
  checked_primary_keys integer NOT NULL CHECK (checked_primary_keys >= 0),
  fixed_queries_passed integer NOT NULL CHECK (fixed_queries_passed >= 0),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  passed boolean NOT NULL,
  report_sha256 char(64) NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- IDX-014/015：发布后旧数据清理与跨存储对账均由可租约、可重试任务驱动。
CREATE TABLE index_maintenance_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type varchar(24) NOT NULL CHECK (task_type IN ('CLEANUP_MANIFEST', 'RECONCILE_MANIFEST', 'REPAIR_MANIFEST')),
  manifest_id uuid NOT NULL REFERENCES space_manifests(id),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'WAITING', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  last_error varchar(500),
  last_result jsonb CHECK (last_result IS NULL OR jsonb_typeof(last_result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_index_maintenance UNIQUE (task_type, manifest_id)
);

CREATE INDEX idx_index_maintenance_claim
  ON index_maintenance_tasks (available_at, created_at)
  WHERE status IN ('QUEUED', 'WAITING');

-- IDX-016：Profile 重建/灰度请求持久化，避免只靠一次性脚本且无法审计。
CREATE TABLE index_rebuild_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  embedding_profile_id varchar(100) NOT NULL,
  mode varchar(12) NOT NULL CHECK (mode IN ('FULL', 'CANARY')),
  canary_percent integer NOT NULL CHECK (canary_percent BETWEEN 1 AND 100),
  status varchar(20) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'BUILDING', 'EVALUATING', 'READY', 'PUBLISHED', 'ROLLED_BACK', 'FAILED')
  ),
  reason varchar(500) NOT NULL,
  requested_by varchar(128) NOT NULL,
  requested_roles text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_index_rebuild_queue ON index_rebuild_requests (status, created_at);

COMMENT ON TABLE space_manifest_heads IS
  '在线检索唯一可见性指针；Milvus 写入成功不能替代该 PG 原子事实。';
COMMENT ON COLUMN embedding_facts.dense_vector IS
  '为内容 Hash + Profile 幂等复用保存的向量事实；Chunk 正文仍只保存在 PG knowledge_chunks。';
