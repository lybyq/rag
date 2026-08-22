-- M06 增量：摘要密文必须保存明文 Hash，解密后才能验证内容未被替换。

ALTER TABLE conversation_states
  ADD COLUMN summary_sha256 char(64) CHECK (
    summary_sha256 IS NULL OR summary_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE conversation_states
  DROP CONSTRAINT conversation_state_summary_shape;

ALTER TABLE conversation_states
  ADD CONSTRAINT conversation_state_summary_shape CHECK (
    (summary_storage IS NULL AND summary_value IS NULL AND summary_iv IS NULL
      AND summary_auth_tag IS NULL AND summary_sha256 IS NULL)
    OR (summary_storage = 'AES_256_GCM' AND summary_value IS NOT NULL
      AND summary_iv IS NOT NULL AND summary_auth_tag IS NOT NULL AND summary_sha256 IS NOT NULL)
    OR (summary_storage IN ('REDACTED', 'PLAIN') AND summary_value IS NOT NULL
      AND summary_iv IS NULL AND summary_auth_tag IS NULL AND summary_sha256 IS NOT NULL)
  );

