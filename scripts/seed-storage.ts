/**
 * 对象存储生产初始化脚本。
 *
 * Compose/Kubernetes 首次部署在应用接流量前调用本脚本，幂等创建原文、派生物、制品和隔离
 * 上传 Bucket。它只负责对象存储结构，不创建开发身份、测试知识或业务数据；任何 Bucket 创建
 * 失败都会让一次性初始化 Job 失败，从而阻止依赖它的 API/Worker 带病启动。
 *
 * @requirement ING-002
 * @requirement PAR-007
 * @requirement OPS-014
 */
import { loadAppConfig, loadProfileEnvironment } from '@rag/config';
import { Client } from 'minio';

const config = loadAppConfig(loadProfileEnvironment(process.env));
const endpoint = new URL(config.minio.endpoint);
const client = new Client({
  endPoint: endpoint.hostname,
  port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
  useSSL: endpoint.protocol === 'https:',
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

/** 创建所有运行时 Bucket；Set 去除配置重名，重复执行不会覆盖已有对象。 */
async function main(): Promise<void> {
  const buckets = new Set([
    'rag-documents',
    'rag-artifacts',
    config.minio.uploadBucket,
    config.fileProcessing.derivedBucket,
  ]);
  for (const bucket of buckets) {
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    process.stdout.write(`READY ${bucket}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Storage initialization failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
