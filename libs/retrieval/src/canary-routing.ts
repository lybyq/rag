/**
 * M05 Profile 灰度的稳定路由算法。
 * 同一个 userId 在同一 routingSalt 下始终进入相同分桶，避免一次会话在两个 Manifest 间抖动。
 * 本规则不读取数据库；M07 只需传入 PG 中的 stable/candidate/percent 事实。
 *
 * @requirement IDX-016
 */
import { createHash } from 'node:crypto';

/** 灰度指针最小输入。 */
export interface ManifestCanaryRoute {
  readonly stableManifestId: string;
  readonly candidateManifestId: string;
  readonly canaryPercent: number;
  readonly routingSalt: string;
}

/** 按 userId 稳定选择 Manifest；非法比例默认拒绝而不是静默全量。 */
export function selectCanaryManifest(userId: string, route: ManifestCanaryRoute): string {
  if (!userId || route.canaryPercent < 1 || route.canaryPercent > 99) {
    throw new Error('Profile CANARY 路由参数非法');
  }
  const digest = createHash('sha256').update(`${route.routingSalt}:${userId}`).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < route.canaryPercent ? route.candidateManifestId : route.stableManifestId;
}
