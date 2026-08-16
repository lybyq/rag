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
});
