import { AppConfigError, loadAppConfig } from './app-config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

describe('[BASE-010] startup configuration', () => {
  it('开发环境使用明确的本地安全默认值', () => {
    const config = loadAppConfig({ APP_ENV: 'development', APP_NAME: 'test-api' });

    expect(config.appName).toBe('test-api');
    expect(config.databaseUrl).toContain('localhost');
    expect(config.corsAllowedOrigins).toEqual(['http://localhost:5173']);
  });

  it('生产环境拒绝本地默认口令和未声明 TLS 的数据库连接', () => {
    expect(() => loadAppConfig({ APP_ENV: 'production', APP_NAME: 'production-api' })).toThrow(
      AppConfigError,
    );
  });

  it('非法端口不会被静默接受', () => {
    expect(() => loadAppConfig({ HTTP_PORT: '99999' })).toThrow(AppConfigError);
  });

  it('[AUTH-003] production 明确拒绝 Mock 认证', () => {
    expect(() =>
      loadAppConfig({
        APP_ENV: 'production',
        AUTH_MODE: 'mock',
        DATABASE_URL: 'postgresql://rag:secret@db.internal/rag?sslmode=require',
        MINIO_ACCESS_KEY: 'production-access',
        MINIO_SECRET_KEY: 'production-secret-value',
      }),
    ).toThrow(/production 禁止启用 mock/);
  });

  it('[AUTH-005] JWT 模式缺少校验目标时启动失败', () => {
    expect(() => loadAppConfig({ APP_ENV: 'development', AUTH_MODE: 'jwt' })).toThrow(
      /JWT 模式必须配置/,
    );
  });

  it('[PAR-003][PAR-004] production 拒绝结构安全能力不完整的 Docling 直连 Parser', () => {
    expect(() =>
      loadAppConfig({
        APP_ENV: 'production',
        AUTH_MODE: 'trusted-header',
        AUTH_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
        DATABASE_URL: 'postgresql://rag:secret@db.internal/rag?sslmode=require',
        MINIO_ACCESS_KEY: 'production-access',
        MINIO_SECRET_KEY: 'production-secret-value',
        PARSER_ADAPTER: 'docling',
        SCANNER_ADAPTER: 'builtin',
        OCR_ADAPTER: 'http',
      }),
    ).toThrow(/PARSER_ADAPTER_STRUCTURE_SCAN/);
  });

  it('[KNO-007] 拒绝 Parent 小于 Child 或 overlap 不小于 Child 的分块预算', () => {
    expect(() =>
      loadAppConfig({
        CHUNK_CHILD_MAX_TOKENS: '512',
        CHUNK_PARENT_MAX_TOKENS: '256',
      }),
    ).toThrow(/Parent Token 上限/);
    expect(() =>
      loadAppConfig({
        CHUNK_CHILD_MAX_TOKENS: '512',
        CHUNK_OVERLAP_TOKENS: '512',
      }),
    ).toThrow(/重叠 Token/);
  });

  it('[KNO-009] 拒绝相互倒置的质量人工复核与硬拒绝阈值', () => {
    expect(() =>
      loadAppConfig({
        QUALITY_MIN_NON_EMPTY_BLOCK_RATIO: '0.4',
        QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO: '0.5',
      }),
    ).toThrow(/覆盖率拒绝阈值/);
    expect(() =>
      loadAppConfig({
        QUALITY_MAX_GARBLED_RATIO: '0.2',
        QUALITY_REJECT_GARBLED_RATIO: '0.1',
      }),
    ).toThrow(/乱码拒绝阈值/);
  });

  it('[CFG-001] external-dev 默认使用自有 Node Parser、Docling OCR 与本地 Fixture 模型组合', () => {
    const config = loadAppConfig({
      APP_ENV: 'development',
      PROVIDER_PROFILE: 'external-dev',
    });

    expect(config.providerProfile).toBe('external-dev');
    expect(config.fileProcessing.parser.adapter).toBe('http');
    expect(config.fileProcessing.parser.profileId).toBe('node-multi-parser-v1');
    expect(config.fileProcessing.ocr.adapter).toBe('docling');
    expect(config.embedding.adapter).toBe('fixture');
    expect(config.reranker.adapter).toBe('fixture');
    expect(config.vectorStore.adapter).toBe('milvus');
  });

  it('[CFG-002] test/CI 画像拒绝任何实时 Provider，避免测试依赖个人密钥或公网', () => {
    expect(() =>
      loadAppConfig({
        APP_ENV: 'test',
        PROVIDER_PROFILE: 'external-ci',
        SCANNER_ADAPTER: 'fixture',
        PARSER_ADAPTER: 'fixture',
        OCR_ADAPTER: 'fixture',
        LLM_ADAPTER: 'openai-compatible',
        EMBEDDING_ADAPTER: 'fixture',
        RERANKER_ADAPTER: 'fixture',
        VECTOR_STORE_ADAPTER: 'memory',
      }),
    ).toThrow(/test\/CI Profile 禁止依赖实时或公网 Provider/);

    const config = loadAppConfig({
      APP_ENV: 'test',
      PROVIDER_PROFILE: 'external-ci',
      SCANNER_ADAPTER: 'fixture',
      PARSER_ADAPTER: 'fixture',
      OCR_ADAPTER: 'fixture',
      LLM_ADAPTER: 'fixture',
      EMBEDDING_ADAPTER: 'fixture',
      RERANKER_ADAPTER: 'fixture',
      VECTOR_STORE_ADAPTER: 'memory',
    });
    expect(config).toMatchObject({
      providerProfile: 'external-ci',
      llm: { adapter: 'fixture' },
      vectorStore: { adapter: 'memory' },
    });
  });

  it('[CFG-001][CFG-003] 合法内网生产配置选择 HTTP 模型组合与 Milvus', () => {
    const config = loadAppConfig(validIntranetProductionEnvironment());

    expect(config.providerProfile).toBe('intranet-production');
    expect(config.fileProcessing.parser.adapter).toBe('http');
    expect(config.fileProcessing.ocr.adapter).toBe('http');
    expect(config.llm.adapter).toBe('openai-compatible');
    expect(config.embedding).toMatchObject({
      adapter: 'http',
      modelId: 'BAAI/bge-m3',
      denseDimension: 1024,
      outputModes: ['dense', 'sparse'],
    });
    expect(config.reranker.modelId).toBe('BAAI/bge-reranker-v2-m3');
    expect(config.vectorStore.adapter).toBe('milvus');
  });

  it('[CFG-003] 内网生产拒绝 Fixture、公网 Endpoint 与占位 revision，但允许配置实际模型维度', () => {
    expect(() =>
      loadAppConfig({
        ...validIntranetProductionEnvironment(),
        EMBEDDING_ADAPTER: 'fixture',
        EMBEDDING_BASE_URL: 'https://api.example.com',
        EMBEDDING_REVISION: '请填写内网实际版本',
        EMBEDDING_DENSE_DIMENSION: '768',
      }),
    ).toThrow(/内网 Profile 存在不安全、占位或不兼容配置/);
  });

  it('[CFG-003] Profile 与 APP_ENV 必须成套切换', () => {
    expect(() =>
      loadAppConfig({ APP_ENV: 'development', PROVIDER_PROFILE: 'intranet-production' }),
    ).toThrow(/必须与 APP_ENV=production 配套/);
  });

  it('[CFG-004] 拒绝 Reranker TopN 越界及 Chunk 超过模型输入预算', () => {
    expect(() => loadAppConfig({ RERANKER_MAX_CANDIDATES: '10', RERANKER_TOP_N: '11' })).toThrow(
      /TopN/,
    );
    expect(() =>
      loadAppConfig({ CHUNK_CHILD_MAX_TOKENS: '512', EMBEDDING_MAX_INPUT_TOKENS: '512' }),
    ).toThrow(/Embedding 最大输入/);
  });

  it('[CFG-002][CFG-003][CFG-012] 仓库环境模板与启动契约保持同步', () => {
    for (const fileName of ['.env.external-dev.example', '.env.external-ci.example']) {
      expect(() => loadAppConfig(readExampleEnvironment(fileName))).not.toThrow();
    }
    for (const fileName of ['.env.intranet-staging.example', '.env.intranet-production.example']) {
      expect(() => loadAppConfig(readExampleEnvironment(fileName))).toThrow(/占位|缺失配置/);
    }
  });
});

/** 测试可以显式读取模板；生产加载器永远不会把 `.example` 当作运行配置。 */
function readExampleEnvironment(fileName: string): NodeJS.ProcessEnv {
  return parseEnv(readFileSync(resolve(process.cwd(), fileName), 'utf8'));
}

function validIntranetProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'production',
    PROVIDER_PROFILE: 'intranet-production',
    AUTH_MODE: 'trusted-header',
    AUTH_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    DATABASE_URL: 'postgresql://rag:secret@postgres.internal/rag?sslmode=require',
    MINIO_ENDPOINT: 'http://minio.internal:9000',
    MINIO_ACCESS_KEY: 'production-access',
    MINIO_SECRET_KEY: 'production-secret-value',
    SCANNER_ADAPTER: 'builtin',
    PARSER_ADAPTER: 'http',
    PARSER_BASE_URL: 'http://rag-parser.internal:8080',
    PARSER_PROFILE_ID: 'node-multi-parser-intranet-v1',
    PARSER_REVISION: '2026.08.1',
    OCR_ADAPTER: 'http',
    OCR_BASE_URL: 'http://paddleocr.internal:8080',
    OCR_MODEL_ID: 'paddleocr-v4',
    OCR_PROFILE_ID: 'paddleocr-intranet-v1',
    OCR_REVISION: '2026.08.1',
    LLM_ADAPTER: 'openai-compatible',
    LLM_BASE_URL: 'http://llm-gateway.internal/v1',
    LLM_MODEL_ID: 'internal-llm',
    LLM_PROFILE_ID: 'internal-llm-production-v1',
    LLM_REVISION: '2026.08.1',
    EMBEDDING_ADAPTER: 'http',
    EMBEDDING_BASE_URL: 'http://bge-m3.internal:8080',
    EMBEDDING_MODEL_ID: 'BAAI/bge-m3',
    EMBEDDING_PROVIDER_NAME: 'internal-bge-service',
    EMBEDDING_PROFILE_ID: 'bge-m3-intranet-production-v1',
    EMBEDDING_REVISION: '2026.08.1',
    EMBEDDING_DENSE_DIMENSION: '1024',
    EMBEDDING_OUTPUT_MODE: 'dense,sparse',
    EMBEDDING_TOKENIZER_REVISION: 'bge-m3-tokenizer-2026.08.1',
    EMBEDDING_SPARSE_FORMAT_VERSION: 'bge-m3-sparse-v1',
    RERANKER_ADAPTER: 'http',
    RERANKER_BASE_URL: 'http://bge-reranker.internal:8080',
    RERANKER_MODEL_ID: 'BAAI/bge-reranker-v2-m3',
    RERANKER_PROFILE_ID: 'bge-reranker-intranet-production-v1',
    RERANKER_REVISION: '2026.08.1',
    VECTOR_STORE_ADAPTER: 'milvus',
    VECTOR_STORE_PROFILE_ID: 'milvus-intranet-production-v1',
    MILVUS_ADDRESS: 'milvus.internal:19530',
    MILVUS_DATABASE: 'rag',
  };
}
