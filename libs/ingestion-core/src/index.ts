/**
 * M02 文档接入领域规则公共出口。
 * 这里保持纯函数，不依赖 NestJS、PostgreSQL、MinIO 或浏览器。
 */
export * from './ingestion-identity';
export * from './ingestion-progress';
export * from './ingestion-state-machine';
export * from './upload-policy';
