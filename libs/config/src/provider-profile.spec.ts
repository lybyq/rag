/**
 * Provider Profile 启动加载器测试。
 * 使用临时目录证明固定文件映射、Secret 优先级和非法 Profile fail-closed，不依赖个人真实 `.env`。
 *
 * @requirement CFG-001
 * @requirement CFG-002
 * @requirement CFG-003
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfileEnvironment } from './provider-profile';

describe('[CFG-001][CFG-002][CFG-003] provider profile environment', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('只读取枚举映射的 Profile 文件', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rag-provider-profile-'));
    directories.push(directory);
    writeFileSync(
      join(directory, '.env.external-dev'),
      'PARSER_ADAPTER=docling\nOCR_ADAPTER=docling\n',
      'utf8',
    );

    expect(
      loadProfileEnvironment({ PROVIDER_PROFILE: 'external-dev' }, { rootDirectory: directory }),
    ).toMatchObject({
      PROVIDER_PROFILE: 'external-dev',
      PARSER_ADAPTER: 'docling',
      OCR_ADAPTER: 'docling',
    });
  });

  it('容器或 Secret Manager 注入值覆盖 Profile 文件中的旧值', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rag-provider-secret-'));
    directories.push(directory);
    writeFileSync(
      join(directory, '.env.intranet-production'),
      'LLM_API_KEY=old-file-secret\nLLM_MODEL_ID=old-model\n',
      'utf8',
    );

    const result = loadProfileEnvironment(
      {
        PROVIDER_PROFILE: 'intranet-production',
        LLM_API_KEY: 'injected-secret',
      },
      { rootDirectory: directory },
    );

    expect(result.LLM_API_KEY).toBe('injected-secret');
    expect(result.LLM_MODEL_ID).toBe('old-model');
  });

  it('路径穿越或未知 Profile 在读取文件前失败', () => {
    expect(() => loadProfileEnvironment({ PROVIDER_PROFILE: '../../secret' })).toThrow();
  });
});
