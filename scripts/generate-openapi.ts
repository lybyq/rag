/** 从 Zod 真相源确定性生成两类 HTTP 服务的 OpenAPI 3.1 文档。 */
import { buildBaseOpenApiDocument } from '@rag/contracts';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve(process.cwd(), 'openapi/generated');

const documents = [
  {
    fileName: 'platform-api.json',
    document: buildBaseOpenApiDocument({
      title: 'Enterprise RAG Platform API',
      description: '知识空间、文档接入和平台治理 API',
      version: '0.1.0',
      includeM01: true,
    }),
  },
  {
    fileName: 'rag-query-service.json',
    document: buildBaseOpenApiDocument({
      title: 'Enterprise RAG Query API',
      description: '企业知识问答和证据检索 API',
      version: '0.1.0',
    }),
  },
] as const;

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    documents.map(({ fileName, document }) =>
      writeFile(
        resolve(outputDirectory, fileName),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      ),
    ),
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `OpenAPI generation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
