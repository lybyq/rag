/** 创建 M00 本地开发所需的对象存储 Bucket；操作可重复执行。 */
import { loadAppConfig } from '@rag/config';
import { Client } from 'minio';

const config = loadAppConfig(process.env);
const endpoint = new URL(config.minio.endpoint);
const client = new Client({
  endPoint: endpoint.hostname,
  port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
  useSSL: endpoint.protocol === 'https:',
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

async function main(): Promise<void> {
  for (const bucket of ['rag-documents', 'rag-artifacts']) {
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    process.stdout.write(`READY ${bucket}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
