/**
 * 知识空间、ACL、策略版本和管理 API 的运行时契约。
 * 所有 HTTP 输入都先经过这些 Zod Schema，再进入应用用例。
 *
 * @requirement AUTH-007
 * @requirement AUTH-008
 * @requirement AUTH-009
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { SemanticRoleSchema, UserContextSchema } from './auth';

/** ACL 可授予的四种原子权限。权限蕴含关系由领域层解释。 */
export const SpacePermissionSchema = z.enum(['READ', 'WRITE', 'REVIEW', 'ADMIN']);
export type SpacePermission = z.infer<typeof SpacePermissionSchema>;

/** ACL 主体可以是一个用户，也可以是一项映射后的系统语义角色。 */
export const AclSubjectTypeSchema = z.enum(['USER', 'ROLE']);
export type AclSubjectType = z.infer<typeof AclSubjectTypeSchema>;

/** 首版只允许正常服务和停用两种空间状态，避免物理删除破坏审计链。 */
export const KnowledgeSpaceStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type KnowledgeSpaceStatus = z.infer<typeof KnowledgeSpaceStatusSchema>;

/** API 和数据库共享的空间编码约束。 */
export const KnowledgeSpaceCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, '编码必须是小写 kebab-case');

/** 知识空间详情。version 用于基本信息的乐观锁。 */
export const KnowledgeSpaceSchema = z.object({
  id: z.uuid(),
  code: KnowledgeSpaceCodeSchema,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable(),
  ownerUserId: z.string().trim().min(1).max(128),
  status: KnowledgeSpaceStatusSchema,
  version: z.number().int().positive(),
  policyVersion: z.number().int().positive(),
  documentCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  effectivePermissions: z.array(SpacePermissionSchema),
});
export type KnowledgeSpace = z.infer<typeof KnowledgeSpaceSchema>;

/** 创建空间时，负责人缺省为当前用户，不能从客户端提交角色。 */
export const CreateKnowledgeSpaceRequestSchema = z.object({
  code: KnowledgeSpaceCodeSchema,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().default(null),
  ownerUserId: z.string().trim().min(1).max(128).optional(),
});
export type CreateKnowledgeSpaceRequest = z.infer<typeof CreateKnowledgeSpaceRequestSchema>;

/** 更新必须携带读取时看到的版本，防止两个管理员互相覆盖。 */
export const UpdateKnowledgeSpaceRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: '至少提交一个需要更新的字段',
  });
export type UpdateKnowledgeSpaceRequest = z.infer<typeof UpdateKnowledgeSpaceRequestSchema>;

/** 停用属于治理操作，原因会进入审计而不是自由丢弃。 */
export const DeactivateKnowledgeSpaceRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(300),
});
export type DeactivateKnowledgeSpaceRequest = z.infer<typeof DeactivateKnowledgeSpaceRequestSchema>;

/** 创建或替换一个 ACL 授权。 */
export const UpsertSpaceGrantRequestSchema = z
  .object({
    subjectType: AclSubjectTypeSchema,
    subjectId: z.string().trim().min(1).max(128),
    permissions: z.array(SpacePermissionSchema).min(1),
    reason: z.string().trim().min(2).max(300),
  })
  .superRefine((value, context) => {
    if (value.subjectType === 'ROLE' && !SemanticRoleSchema.safeParse(value.subjectId).success) {
      context.addIssue({
        code: 'custom',
        path: ['subjectId'],
        message: 'ROLE 主体必须是已知系统语义角色',
      });
    }
  });
export type UpsertSpaceGrantRequest = z.infer<typeof UpsertSpaceGrantRequestSchema>;

/** 撤销授权同样要求原因；主体由 URL 精确定位。 */
export const RevokeSpaceGrantRequestSchema = z.object({
  reason: z.string().trim().min(2).max(300),
});
export type RevokeSpaceGrantRequest = z.infer<typeof RevokeSpaceGrantRequestSchema>;

/** 空间 ACL 记录。 */
export const SpaceGrantSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  subjectType: AclSubjectTypeSchema,
  subjectId: z.string().min(1),
  permissions: z.array(SpacePermissionSchema),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type SpaceGrant = z.infer<typeof SpaceGrantSchema>;

/** 每次 ACL 改变都会留下不可变的策略快照版本。 */
export const KnowledgeSpacePolicyVersionSchema = z.object({
  spaceId: z.uuid(),
  version: z.number().int().positive(),
  grants: z.array(SpaceGrantSchema),
  changedBy: z.string().min(1),
  changeReason: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});
export type KnowledgeSpacePolicyVersion = z.infer<typeof KnowledgeSpacePolicyVersionSchema>;

/** 列表查询只接受服务端支持的过滤条件。 */
export const ListKnowledgeSpacesQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  status: KnowledgeSpaceStatusSchema.optional(),
});
export type ListKnowledgeSpacesQuery = z.infer<typeof ListKnowledgeSpacesQuerySchema>;

/** M01 管理台所需的成功响应信封。 */
export const IdentitySessionSchema = z.object({
  user: UserContextSchema.pick({ userId: true, roles: true, authzVersion: true, resolvedAt: true }),
  authMode: z.enum(['mock', 'trusted-header', 'jwt']),
  appEnv: z.enum(['test', 'development', 'staging', 'production']),
});
export type IdentitySession = z.infer<typeof IdentitySessionSchema>;
export const UserContextEnvelopeSchema = createApiEnvelopeSchema(IdentitySessionSchema);

/** 开发身份选择页只能拿到预置数据，不能自定义 userId/roles。 */
export const DevelopmentIdentityPresetSchema = z.object({
  presetId: z.string().min(1),
  label: z.string().min(1),
  userId: z.string().min(1),
  roles: z.array(SemanticRoleSchema),
});
export type DevelopmentIdentityPreset = z.infer<typeof DevelopmentIdentityPresetSchema>;
export const DevelopmentIdentityPresetListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({
    selectionHeader: z.string().min(1),
    defaultPresetId: z.string().min(1),
    items: z.array(DevelopmentIdentityPresetSchema),
  }),
);
export const KnowledgeSpaceEnvelopeSchema = createApiEnvelopeSchema(KnowledgeSpaceSchema);
export const KnowledgeSpaceListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(KnowledgeSpaceSchema), total: z.number().int().nonnegative() }),
);
export const SpaceGrantListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(SpaceGrantSchema) }),
);
export const SpaceGrantEnvelopeSchema = createApiEnvelopeSchema(SpaceGrantSchema);
export const RevokeSpaceGrantEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ revoked: z.literal(true) }),
);
export const PolicyVersionListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(KnowledgeSpacePolicyVersionSchema) }),
);
