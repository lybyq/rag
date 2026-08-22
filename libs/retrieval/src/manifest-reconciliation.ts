/**
 * M05 发布前 Manifest 对账纯算法。
 *
 * 对账只比较主键、Hash、Profile 与固定查询结果，不读取 Chunk 正文。
 * 产出的稳定 SHA 可写入 PostgreSQL，证明实际发布的是哪一份报告。
 *
 * @requirement IDX-010
 */
import { createHash } from 'node:crypto';
import {
  IndexReconciliationReportSchema,
  type IndexReconciliationIssue,
  type IndexReconciliationReport,
} from '@rag/contracts';

/** PG 期望记录的最小事实。 */
export interface ExpectedManifestRecord {
  readonly vectorId: string;
  readonly contentSha256: string;
}

/** Milvus 实际记录的最小可对账事实。 */
export interface ActualManifestRecord extends ExpectedManifestRecord {
  readonly embeddingProfileId: string;
}

/** 一次发布前对账输入。 */
export interface ReconcileManifestInput {
  readonly manifestId: string;
  readonly embeddingProfileId: string;
  readonly expected: readonly ExpectedManifestRecord[];
  readonly actual: readonly ActualManifestRecord[];
  readonly fixedQueryExpectedIds: readonly string[];
  readonly fixedQueryReturnedIds: readonly string[];
}

/** 执行确定性全量主键对账；任何问题都会让 passed=false。 */
export function reconcileManifestRecords(input: ReconcileManifestInput): IndexReconciliationReport {
  const issues: IndexReconciliationIssue[] = [];
  const expected = new Map(input.expected.map((item) => [item.vectorId, item]));
  const actual = new Map(input.actual.map((item) => [item.vectorId, item]));
  if (expected.size !== actual.size) {
    issues.push(issue('COUNT_MISMATCH', null, 'PG 与 Milvus 向量数量不一致', true));
  }
  for (const [vectorId, wanted] of expected) {
    const found = actual.get(vectorId);
    if (!found) {
      issues.push(issue('MISSING_PRIMARY_KEY', vectorId, 'Milvus 缺少期望主键', true));
      continue;
    }
    if (found.contentSha256 !== wanted.contentSha256) {
      issues.push(issue('CONTENT_HASH_MISMATCH', vectorId, '向量内容 Hash 与 PG 不一致', true));
    }
    if (found.embeddingProfileId !== input.embeddingProfileId) {
      issues.push(issue('PROFILE_MISMATCH', vectorId, '向量 Profile 与 Manifest 不一致', false));
    }
  }
  for (const vectorId of actual.keys()) {
    if (!expected.has(vectorId)) {
      issues.push(issue('UNEXPECTED_PRIMARY_KEY', vectorId, 'Milvus 出现 Manifest 外主键', true));
    }
  }
  const fixedQueriesMatch = arraysEqual(
    [...input.fixedQueryExpectedIds].sort(),
    [...input.fixedQueryReturnedIds].sort(),
  );
  if (!fixedQueriesMatch) {
    issues.push(issue('FIXED_QUERY_MISMATCH', null, '固定关键查询返回集合不一致', false));
  }

  issues.sort((left, right) =>
    `${left.code}:${left.vectorId ?? ''}`.localeCompare(`${right.code}:${right.vectorId ?? ''}`),
  );
  const reportBody = {
    manifestId: input.manifestId,
    expectedCount: expected.size,
    actualCount: actual.size,
    checkedPrimaryKeys: expected.size,
    fixedQueriesPassed: fixedQueriesMatch ? 1 : 0,
    issues,
    passed: issues.length === 0,
  };
  return IndexReconciliationReportSchema.parse({
    ...reportBody,
    reportSha256: createHash('sha256').update(JSON.stringify(reportBody)).digest('hex'),
  });
}

function issue(
  code: IndexReconciliationIssue['code'],
  vectorId: string | null,
  publicMessage: string,
  repairable: boolean,
): IndexReconciliationIssue {
  return { code, vectorId, publicMessage, repairable };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
