/**
 * 前端操作可见性只改善体验；后端仍会逐次鉴权。
 * 单独提取纯函数便于用权限矩阵测试所有按钮状态。
 */
import type { KnowledgeSpace } from '@rag/contracts';

export interface SpaceActionVisibility {
  manage: boolean;
  edit: boolean;
  deactivate: boolean;
}

export function getSpaceActionVisibility(space: KnowledgeSpace): SpaceActionVisibility {
  return {
    manage: space.effectivePermissions.includes('ADMIN'),
    edit: space.effectivePermissions.includes('WRITE'),
    deactivate: space.status === 'ACTIVE' && space.effectivePermissions.includes('ADMIN'),
  };
}
