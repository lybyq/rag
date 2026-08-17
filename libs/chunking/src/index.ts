/**
 * M04 文档结构恢复、真实 Tokenizer、专用 Chunker、可逆去重和质量 Policy 公共出口。
 * 这里只导出纯算法；持久化、权限和任务事务位于 Application/Adapter。
 *
 * @requirement KNO-002
 * @requirement KNO-003
 * @requirement KNO-009
 */
export const CHUNKING_BOUNDARY = 'chunking' as const;
export * from './chunk-builder';
export * from './quality-policy';
export * from './review-policy';
export * from './structure-recovery';
export * from './tokenizer';
export type * from './types';
