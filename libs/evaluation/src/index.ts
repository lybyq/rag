/**
 * 评测纯逻辑库公共出口。
 * 只导出确定性评分和基线比较，不依赖 NestJS、PostgreSQL 或模型 SDK。
 */
export * from './scorers';
