-- M01：身份授权、知识空间、ACL、策略版本和审计事实表。
-- 业务 API 不提供物理删除；授权历史通过不可变策略快照保留。

CREATE TABLE authorization_state (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO authorization_state (singleton_id, version)
VALUES (1, 1)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE knowledge_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  name varchar(80) NOT NULL,
  description varchar(500),
  owner_user_id varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_spaces_status_updated
  ON knowledge_spaces (status, updated_at DESC);
CREATE INDEX idx_knowledge_spaces_owner
  ON knowledge_spaces (owner_user_id);

CREATE TABLE resource_acl (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type varchar(32) NOT NULL DEFAULT 'KNOWLEDGE_SPACE'
    CHECK (resource_type = 'KNOWLEDGE_SPACE'),
  resource_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  subject_type varchar(8) NOT NULL CHECK (subject_type IN ('USER', 'ROLE')),
  subject_id varchar(128) NOT NULL,
  permissions text[] NOT NULL,
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_resource_acl_subject UNIQUE (resource_type, resource_id, subject_type, subject_id),
  CONSTRAINT ck_resource_acl_permissions CHECK (
    cardinality(permissions) > 0
    AND permissions <@ ARRAY['READ', 'WRITE', 'REVIEW', 'ADMIN']::text[]
  )
);

CREATE INDEX idx_resource_acl_subject
  ON resource_acl (subject_type, subject_id, resource_id);
CREATE INDEX idx_resource_acl_resource
  ON resource_acl (resource_id);

CREATE TABLE knowledge_space_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  version integer NOT NULL CHECK (version >= 1),
  grants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(grants) = 'array'),
  changed_by varchar(128) NOT NULL,
  change_reason varchar(300) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_space_policy_version UNIQUE (space_id, version)
);

CREATE INDEX idx_knowledge_space_policies_space_version
  ON knowledge_space_policies (space_id, version DESC);

-- 后续文档、引用、历史、候选和导出模块写入这张反查索引，统一重鉴权。
CREATE TABLE protected_resource_spaces (
  resource_type varchar(32) NOT NULL CHECK (
    resource_type IN ('DOCUMENT', 'CITATION', 'HISTORY_MESSAGE', 'RETRIEVAL_CANDIDATE', 'EXPORT')
  ),
  resource_id varchar(128) NOT NULL,
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX idx_protected_resource_spaces_space
  ON protected_resource_spaces (space_id, resource_type);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id varchar(128),
  actor_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  authz_version bigint,
  action varchar(80) NOT NULL,
  resource_type varchar(40) NOT NULL,
  resource_id varchar(128),
  result varchar(16) NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'FAILURE')),
  reason varchar(300),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  request_id varchar(128) NOT NULL,
  trace_id varchar(64)
);

CREATE INDEX idx_audit_logs_occurred_at ON audit_logs (occurred_at DESC);
CREATE INDEX idx_audit_logs_actor_time ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_resource_time
  ON audit_logs (resource_type, resource_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_denied_time
  ON audit_logs (occurred_at DESC) WHERE result = 'DENIED';
