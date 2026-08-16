-- M00 只启用通用 UUID 能力；业务表从 M01 起通过正式 migration 创建。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
