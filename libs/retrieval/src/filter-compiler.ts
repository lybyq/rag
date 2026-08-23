/**
 * M07 服务端检索 FilterCompiler。
 *
 * 调用者只能提供 Run 已冻结 Manifest、当前重新授权后的空间集合与检索时点；编译器输出固定字段/
 * 操作符的结构化 AST。Adapter 再使用参数化 SQL或校验后的 UUID 生成 Milvus Filter，任何原始
 * SQL/Milvus 表达式都没有进入本函数的参数通道。
 *
 * @requirement RET-006
 * @requirement RET-007
 * @requirement RET-013
 */
import {
  RetrievalFilterSchema,
  type RetrievalFilter,
  type RunManifestSnapshot,
} from '@rag/contracts';

/** FilterCompiler 输入只接受服务端事实。 */
export interface CompileRetrievalFilterInput {
  readonly manifests: readonly RunManifestSnapshot[];
  readonly currentlyAllowedSpaceIds: readonly string[];
  readonly asOf: Date;
}

/** 编译运行快照、当前权限、发布与生效时间约束；无交集时返回拒绝态空结果错误。 */
export function compileRetrievalFilter(input: CompileRetrievalFilterInput): RetrievalFilter {
  const allowed = new Set(input.currentlyAllowedSpaceIds);
  const manifests = input.manifests.filter((manifest) => allowed.has(manifest.spaceId));
  if (manifests.length === 0) throw new Error('当前身份没有可检索的知识空间');
  const asOf = input.asOf.toISOString();
  return RetrievalFilterSchema.parse({
    compilerVersion: 'retrieval-filter-v1',
    asOf,
    requireManifestMembership: true,
    requireCurrentDocumentVersion: true,
    clauses: [
      { field: 'SPACE_ID', operator: 'IN', value: unique(manifests.map((item) => item.spaceId)) },
      {
        field: 'MANIFEST_ID',
        operator: 'IN',
        value: unique(manifests.map((item) => item.manifestId)),
      },
      { field: 'DOCUMENT_STATUS', operator: 'EQ', value: 'ACTIVE' },
      {
        field: 'MANIFEST_STATUS',
        operator: 'IN',
        value: ['ACTIVE', 'SUPERSEDED', 'VERIFIED'],
      },
      { field: 'PUBLISHED_AT', operator: 'LTE', value: asOf },
      { field: 'EFFECTIVE_FROM', operator: 'LTE', value: asOf },
      { field: 'EFFECTIVE_TO', operator: 'NULL_OR_GT', value: asOf },
    ],
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
