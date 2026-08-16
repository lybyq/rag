/** 系统语义角色是身份契约和可信上下文共同依赖的基础值对象。 */
import { z } from 'zod';

export const SemanticRoleSchema = z.enum([
  'KNOWLEDGE_READER',
  'KNOWLEDGE_EDITOR',
  'KNOWLEDGE_REVIEWER',
  'KNOWLEDGE_ADMIN',
  'SYSTEM_ADMIN',
  'AUDITOR',
]);

export type SemanticRole = z.infer<typeof SemanticRoleSchema>;
