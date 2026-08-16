/**
 * 集中定义并校验进程配置。
 * 开发环境提供可安全启动的本地默认值，生产环境禁止默认口令和未加密连接。
 *
 * @requirement BASE-010
 * @requirement CFG-003
 */
import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** 将逗号分隔值转换为去空白后的字符串数组。 */
const CsvSchema = z
  .string()
  .default('http://localhost:5173')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** 应用配置的原始环境变量 Schema。 */
export const AppEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['test', 'development', 'staging', 'production']).default('development'),
    APP_NAME: z.string().min(1).default('rag-service'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PROBE_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    DEPENDENCY_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

    DATABASE_URL: z.string().url().default('postgresql://rag:rag-local-only@localhost:5432/rag'),
    REDIS_CACHE_URL: z.string().url().default('redis://localhost:6379/0'),
    REDIS_BULLMQ_URL: z.string().url().default('redis://localhost:6380/0'),

    MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
    MINIO_ACCESS_KEY: z.string().min(1).default('rag-local'),
    MINIO_SECRET_KEY: z.string().min(8).default('rag-local-secret'),

    MILVUS_ADDRESS: z.string().min(1).default('localhost:19530'),
    MILVUS_USERNAME: z.string().default(''),
    MILVUS_PASSWORD: z.string().default(''),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAMESPACE: z.string().min(1).default('enterprise-rag'),
    OTEL_TRACES_ENABLED: z.enum(['true', 'false']).default('false'),

    CORS_ALLOWED_ORIGINS: CsvSchema,
  })
  .superRefine((value, context) => {
    if (value.APP_ENV !== 'production') return;

    const insecureReasons: string[] = [];
    if (value.DATABASE_URL.includes('rag-local-only')) insecureReasons.push('DATABASE_URL');
    if (value.MINIO_ACCESS_KEY === 'rag-local') insecureReasons.push('MINIO_ACCESS_KEY');
    if (value.MINIO_SECRET_KEY === 'rag-local-secret') insecureReasons.push('MINIO_SECRET_KEY');
    if (!value.DATABASE_URL.includes('sslmode=')) insecureReasons.push('DATABASE_URL_SSL');

    if (insecureReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['APP_ENV'],
        message: `生产环境存在不安全或缺失配置：${insecureReasons.join(', ')}`,
      });
    }
  });

/** 经过校验和类型转换的应用配置。 */
export interface AppConfig {
  appEnv: 'test' | 'development' | 'staging' | 'production';
  appName: string;
  httpPort: number;
  probePort: number;
  logLevel: (typeof logLevels)[number];
  dependencyHealthTimeoutMs: number;
  databaseUrl: string;
  redisCacheUrl: string;
  redisBullmqUrl: string;
  minio: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
  };
  milvus: {
    address: string;
    username?: string;
    password?: string;
  };
  otel: {
    endpoint?: string;
    namespace: string;
    tracesEnabled: boolean;
  };
  corsAllowedOrigins: readonly string[];
}

/** 配置校验失败时使用的稳定错误，不包含环境变量的实际值。 */
export class AppConfigError extends Error {
  public constructor(public readonly issues: string[]) {
    super(`应用配置校验失败：${issues.join('；')}`);
    this.name = 'AppConfigError';
  }
}

/**
 * 把不可信的进程环境变量转换成内部只读配置。
 * 错误只报告字段路径和原因，避免把密钥值写入启动日志。
 */
export function loadAppConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const result = AppEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new AppConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
    );
  }

  const value = result.data;
  return Object.freeze({
    appEnv: value.APP_ENV,
    appName: value.APP_NAME,
    httpPort: value.HTTP_PORT,
    probePort: value.PROBE_PORT,
    logLevel: value.LOG_LEVEL,
    dependencyHealthTimeoutMs: value.DEPENDENCY_HEALTH_TIMEOUT_MS,
    databaseUrl: value.DATABASE_URL,
    redisCacheUrl: value.REDIS_CACHE_URL,
    redisBullmqUrl: value.REDIS_BULLMQ_URL,
    minio: Object.freeze({
      endpoint: value.MINIO_ENDPOINT,
      accessKey: value.MINIO_ACCESS_KEY,
      secretKey: value.MINIO_SECRET_KEY,
    }),
    milvus: Object.freeze({
      address: value.MILVUS_ADDRESS,
      ...(value.MILVUS_USERNAME ? { username: value.MILVUS_USERNAME } : {}),
      ...(value.MILVUS_PASSWORD ? { password: value.MILVUS_PASSWORD } : {}),
    }),
    otel: Object.freeze({
      ...(value.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: value.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
      namespace: value.OTEL_SERVICE_NAMESPACE,
      tracesEnabled: value.OTEL_TRACES_ENABLED === 'true',
    }),
    corsAllowedOrigins: Object.freeze([...value.CORS_ALLOWED_ORIGINS]),
  });
}
