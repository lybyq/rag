import { AppConfigError, loadAppConfig } from './app-config';

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
        SCANNER_ADAPTER: 'clamd',
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
});
