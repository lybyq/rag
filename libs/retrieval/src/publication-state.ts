/**
 * M05 Manifest 发布状态机。
 * 状态转换必须先通过这里，禁止 Controller、Worker 或 Repository 各自允许不同的可见性路径。
 *
 * @requirement IDX-009
 * @requirement IDX-011
 * @requirement IDX-013
 */
import type { SpaceManifestStatus } from '@rag/contracts';

/** 非法转换使用稳定领域错误，避免构建中向量被误标为在线。 */
export class IllegalManifestTransitionError extends Error {
  public constructor(
    public readonly from: SpaceManifestStatus,
    public readonly to: SpaceManifestStatus,
  ) {
    super(`Manifest 不允许从 ${from} 转换为 ${to}`);
    this.name = 'IllegalManifestTransitionError';
  }
}

const transitions: Readonly<Record<SpaceManifestStatus, readonly SpaceManifestStatus[]>> = {
  BUILDING: ['VERIFIED', 'FAILED'],
  VERIFIED: ['ACTIVE', 'FAILED'],
  ACTIVE: ['SUPERSEDED', 'REVOKED'],
  SUPERSEDED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
  FAILED: [],
};

/** 相同状态用于幂等重放；其他转换必须在显式白名单中。 */
export function assertManifestTransition(from: SpaceManifestStatus, to: SpaceManifestStatus): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new IllegalManifestTransitionError(from, to);
}
