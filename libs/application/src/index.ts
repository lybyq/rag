/**
 * 应用层公共出口。
 * 应用层负责组织用例，并通过接口依赖外部能力，不直接依赖具体 Adapter。
 *
 * @requirement BASE-004
 */
export const APPLICATION_BOUNDARY = 'application' as const;
export * from './application.error';
export * from './authorization.service';
export * from './document-ingestion.service';
export * from './document-processing.ports';
export * from './document-processing-admin.service';
export * from './document-processing.service';
export * from './ingestion.ports';
export * from './indexing.ports';
export * from './indexing-admin.service';
export * from './index-maintenance.service';
export * from './profile-rollout.service';
export * from './indexing.service';
export * from './knowledge-space.service';
export * from './knowledge-processing.ports';
export * from './knowledge-processing-admin.service';
export * from './knowledge-processing.service';
export * from './outbox-publisher.service';
export * from './ports';
