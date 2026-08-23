/** 证据、引用和 Claim 对齐的纯业务规则公共出口。 */
export const EVIDENCE_BOUNDARY = 'evidence' as const;
export * from './context-builder';
export * from './deterministic-calculation';
export * from './evidence-builder';
export * from './evidence-router';
