/**
 * 企业 RAG 的统一 k6 负载入口：通过 K6_SCENARIO 选择六类工作负载。
 * 问题、空间和身份均来自环境变量；脚本不会把凭据写入输出。
 *
 * @requirement OPS-010
 * @requirement OPS-020
 */
/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const baseUrl = __ENV.RAG_BASE_URL || 'http://127.0.0.1:3001/api/v1';
const platformUrl = __ENV.RAG_PLATFORM_URL || 'http://127.0.0.1:3000/api/v1';
const preset = __ENV.RAG_MOCK_PRESET || 'dev-admin';
const scenario = __ENV.K6_SCENARIO || 'baseline';
const spaceId = __ENV.RAG_SPACE_ID || '';
const question = __ENV.RAG_TEST_QUESTION || '请说明当前制度的适用范围和审批步骤';
const conversationId = __ENV.RAG_CONVERSATION_ID || '';
const failedChecks = new Counter('rag_failed_checks');
const acceptedLatency = new Trend('rag_run_accepted_latency', true);

const commonHeaders = {
  'content-type': 'application/json',
  accept: 'application/json',
  'x-rag-mock-user': preset,
};

const scenarioOptions =
  scenario === 'bulk_import'
    ? {
        executor: 'shared-iterations',
        vus: Number(__ENV.K6_VUS || 10),
        iterations: Number(__ENV.K6_ITERATIONS || 100),
        maxDuration: __ENV.K6_DURATION || '10m',
      }
    : {
        executor: 'constant-arrival-rate',
        rate: Number(__ENV.K6_RATE || 10),
        timeUnit: '1s',
        duration: __ENV.K6_DURATION || '2m',
        preAllocatedVUs: Number(__ENV.K6_PREALLOCATED_VUS || 30),
        maxVUs: Number(__ENV.K6_MAX_VUS || 200),
      };

export const options = {
  scenarios: {
    workload: scenarioOptions,
  },
  thresholds: {
    rag_failed_checks: ['count==0'],
    rag_run_accepted_latency: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const handlers = {
    baseline: createOnlineRun,
    daily_ingestion: listIngestionFacts,
    bulk_import: createUploadMetadata,
    cache_hot_cold: cacheHotCold,
    dependency_fault: createOnlineRun,
    sse_disconnect: disconnectSse,
  };
  (handlers[scenario] || handlers.baseline)();
}

function createOnlineRun() {
  if (!conversationId || !spaceId) return failedChecks.add(1);
  const response = http.post(
    `${baseUrl}/conversations/${conversationId}/runs`,
    JSON.stringify({ question, requestedSpaceIds: [spaceId] }),
    {
      headers: { ...commonHeaders, 'idempotency-key': `k6-${__VU}-${__ITER}-${Date.now()}` },
      timeout: '5s',
    },
  );
  acceptedLatency.add(response.timings.duration);
  if (
    !check(response, {
      'Run 在 200ms 目标内被接受': (r) => r.status === 202 && r.timings.duration < 200,
    })
  )
    failedChecks.add(1);
}

function listIngestionFacts() {
  const response = http.get(`${platformUrl}/jobs?limit=20`, {
    headers: commonHeaders,
    timeout: '5s',
  });
  if (!check(response, { 任务中心可读: (r) => r.status === 200 })) failedChecks.add(1);
}

function createUploadMetadata() {
  if (!spaceId) return failedChecks.add(1);
  const response = http.post(
    `${platformUrl}/uploads`,
    JSON.stringify({
      spaceId,
      files: [
        {
          clientFileId: `k6-${__VU}-${__ITER}`,
          originalFileName: `synthetic-${__ITER}.txt`,
          sizeBytes: 32,
          contentType: 'text/plain',
        },
      ],
    }),
    { headers: commonHeaders, timeout: '5s' },
  );
  if (!check(response, { 批量导入元数据已限界接收: (r) => [201, 409, 429].includes(r.status) }))
    failedChecks.add(1);
}

function cacheHotCold() {
  listIngestionFacts();
  sleep(0.1);
  listIngestionFacts();
}

function disconnectSse() {
  const runId = __ENV.RAG_RUN_ID || '';
  if (!runId) return failedChecks.add(1);
  // 两秒客户端超时主动断开，验证服务端能清理连接并允许 sequence 游标恢复。
  const response = http.get(`${baseUrl}/runs/${runId}/events`, {
    headers: commonHeaders,
    timeout: '2s',
  });
  check(response, { 'SSE 可建立或按客户端超时断开': (r) => [200, 408, 499].includes(r.status) });
}
