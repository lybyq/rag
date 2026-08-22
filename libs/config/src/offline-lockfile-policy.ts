/**
 * 离线 lockfile 依赖来源判定纯函数。
 * 它只检查会改变依赖下载位置的字段，不把 deprecated/homepage 中的说明 URL 误认为远程制品；
 * 由独立纯函数承载后，门禁脚本和 Jest 可以共享完全相同的安全规则。
 *
 * @requirement CFG-005
 * @requirement CFG-011
 */

/** 返回命中禁止来源的 lockfile 原始行，调用方决定如何展示或阻断。 */
export function findForbiddenLockfileSources(
  lockfile: string,
  forbiddenSources: readonly string[],
): readonly string[] {
  return lockfile.split(/\r?\n/u).filter((line) => {
    const normalized = line.toLowerCase();
    // pnpm 11 会把 deprecated/homepage 等说明性元数据写入 lockfile，其中也可能有文档 URL。
    // 只检查真正决定依赖来源的字段或以协议开头的 package key。
    const isSourceBearingLine =
      /^\s*(?:specifier|version|resolution|tarball):/u.test(normalized) ||
      /^\s*['"]?(?:git\+|github:|gitlab:|bitbucket:|https?:\/\/)/u.test(normalized);
    return isSourceBearingLine && forbiddenSources.some((source) => normalized.includes(source));
  });
}
