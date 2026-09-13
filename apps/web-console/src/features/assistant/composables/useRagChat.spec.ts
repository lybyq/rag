/**
 * 问答真实进度的前端授权投影测试。
 *
 * 该测试只检查用户看得到的行为：后端确认且页面仍可见的空间可以显示名称；只要出现未知或
 * 已撤权 ID，就必须使用后端脱敏文案。它不读取 composable 内部状态。
 *
 * @requirement OPT-011
 */
import type { KnowledgeSpace, RagRunProgressPayload } from '@rag/contracts';
import { describe, expect, it } from 'vitest';
import { authorizedProgressMessage } from './useRagChat';

const visibleSpace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '财务制度',
} as KnowledgeSpace;

function retrievalProgress(ids: readonly string[]): RagRunProgressPayload {
  return {
    phase: 'RETRIEVAL',
    status: 'COMPLETED',
    publicMessage: '已完成知识空间权限检查，正在检索可访问资料。',
    attempt: 1,
    authorizedSpaceIds: [...ids],
  };
}

describe('[OPT-011] authorizedProgressMessage', () => {
  it('仅在后端授权 ID 全部仍对页面可见时展示空间名称', () => {
    expect(authorizedProgressMessage(retrievalProgress([visibleSpace.id]), [visibleSpace])).toBe(
      '正在检索你选择的“财务制度”知识空间。',
    );
  });

  it('遇到未知或已撤权空间时回退脱敏文案，不泄漏历史名称', () => {
    const progress = retrievalProgress([visibleSpace.id, '22222222-2222-4222-8222-222222222222']);
    expect(authorizedProgressMessage(progress, [visibleSpace])).toBe(progress.publicMessage);
  });
});
