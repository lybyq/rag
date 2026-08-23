/**
 * 从 PostgreSQL/MinIO 事实源请求空间级 Milvus 全量重建，不直接修改 Collection。
 * API 仍执行身份、Profile、权限、任务幂等和发布对账。
 *
 * @requirement OPS-013
 */
const baseUrl = process.env.RAG_PLATFORM_URL ?? 'http://127.0.0.1:3000/api/v1';
const spaces = (process.env.RAG_REBUILD_SPACE_IDS ?? '').split(',').filter(Boolean);
const profileId = process.env.RAG_REBUILD_EMBEDDING_PROFILE_ID ?? '';

async function main(): Promise<void> {
  if (spaces.length === 0 || !profileId)
    throw new Error('必须配置 RAG_REBUILD_SPACE_IDS 和 RAG_REBUILD_EMBEDDING_PROFILE_ID');
  for (const spaceId of spaces) {
    const response = await fetch(
      `${baseUrl}/spaces/${encodeURIComponent(spaceId)}/index/rebuilds`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          embeddingProfileId: profileId,
          mode: 'FULL',
          canaryPercent: 100,
          reason: '备份恢复后的 Milvus 事实源重建',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`空间 ${spaceId} 重建请求失败：HTTP ${response.status}`);
    process.stdout.write(`空间 ${spaceId} 已创建重建请求\n`);
  }
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (process.env.RAG_MOCK_PRESET) result['x-rag-mock-user'] = process.env.RAG_MOCK_PRESET;
  if (process.env.RAG_BEARER_TOKEN) result.authorization = `Bearer ${process.env.RAG_BEARER_TOKEN}`;
  return result;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Milvus 重建失败'}\n`);
  process.exitCode = 1;
});

// 本文件由 tsx 独立执行；显式标记为模块，避免全仓 typecheck 时与其他脚本的 main 重名。
export {};
