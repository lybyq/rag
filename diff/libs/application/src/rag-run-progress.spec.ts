/** `run.progress` 只投影授权后的真实计数，且不透传未知摘要字段。 @requirement OPT-011 */
import { progressWhenStepFinishes, progressWhenStepStarts } from './rag-run-progress';

describe('[OPT-011] RagRun public progress', () => {
  it('输出授权空间、可访问文档和实际上下文证据数量', () => {
    const spaceId = '11111111-1111-4111-8111-111111111111';
    expect(
      progressWhenStepFinishes('answer_retrieve', 1, 'SUCCEEDED', {
        authorizedSpaceIds: [spaceId],
        durationMs: 20,
      }),
    ).toMatchObject({ authorizedSpaceIds: [spaceId], publicMessage: expect.stringContaining('1') });
    expect(
      progressWhenStepFinishes('answer_expand_evidence', 1, 'SUCCEEDED', {
        accessibleDocumentCount: 3,
      }),
    ).toMatchObject({ accessibleDocumentCount: 3, publicMessage: expect.stringContaining('3') });
    expect(
      progressWhenStepFinishes('answer_build_context', 1, 'SUCCEEDED', {
        contextIncludedCount: 5,
      }),
    ).toMatchObject({ includedEvidenceCount: 5, publicMessage: expect.stringContaining('5') });
  });

  it('不把问题、正文或非法数量从内部摘要透传给用户事件', () => {
    const progress = progressWhenStepFinishes('answer_expand_evidence', 1, 'SUCCEEDED', {
      accessibleDocumentCount: -1,
      question: '敏感问题',
      content: '敏感正文',
    });
    expect(progress).toEqual({
      phase: 'FILTERING',
      status: 'COMPLETED',
      publicMessage: '已完成来源与权限复核，正在筛选相关资料。',
      attempt: 1,
    });
    expect(JSON.stringify(progress)).not.toContain('敏感');
  });

  it('只为用户有意义的节点生成开始说明', () => {
    expect(progressWhenStepStarts('answer_generate_draft', 1)?.phase).toBe('GENERATION');
    expect(progressWhenStepStarts('answer_rerank', 1)).toBeUndefined();
  });
});
