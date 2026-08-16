/**
 * 将企业 IdP 的原始角色显式映射为系统语义角色。
 * 未配置角色返回空集合，这是 fail-closed，而不是配置疏漏时“尽量猜一个权限”。
 *
 * @requirement AUTH-006
 */
import { SemanticRoleSchema, type SemanticRole } from '@rag/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const RoleMappingFileSchema = z.object({
  mappings: z.record(z.string(), z.array(SemanticRoleSchema)),
});

/** 角色映射器在构造时复制并冻结配置，运行时不会被请求修改。 */
export class RoleMapper {
  private readonly mappings: Readonly<Record<string, readonly SemanticRole[]>>;

  public constructor(mappings: Readonly<Record<string, readonly SemanticRole[]>>) {
    this.mappings = Object.freeze(
      Object.fromEntries(
        Object.entries(mappings).map(([sourceRole, targetRoles]) => [
          sourceRole,
          Object.freeze([...new Set(targetRoles)]),
        ]),
      ),
    );
  }

  /** 映射、去重并排序；未知角色通过空结果自然失去权限。 */
  public map(sourceRoles: readonly string[]): readonly SemanticRole[] {
    const mapped = new Set<SemanticRole>();
    for (const sourceRole of sourceRoles) {
      for (const semanticRole of this.mappings[sourceRole] ?? []) mapped.add(semanticRole);
    }
    return [...mapped].sort();
  }
}

/** 从受版本控制的 YAML 文件加载映射；内容不合法时让进程启动失败。 */
export function loadRoleMapper(filePath: string): RoleMapper {
  const absolutePath = resolve(process.cwd(), filePath);
  const document = RoleMappingFileSchema.parse(parse(readFileSync(absolutePath, 'utf8')));
  return new RoleMapper(document.mappings);
}
