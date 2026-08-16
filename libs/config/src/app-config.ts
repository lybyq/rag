/**
 * 集中定义并校验进程配置。
 * 开发环境提供可安全启动的本地默认值，生产环境禁止默认口令和未加密连接。
 *
 * @requirement BASE-010
 * @requirement CFG-003
 */
import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const authModes = ['mock', 'trusted-header', 'jwt'] as const;

/** 开发身份预置的默认值；选择的是 presetId，而不是让浏览器提交任意角色。 */
const defaultMockPresets = JSON.stringify([
  {
    presetId: 'dev-admin',
    label: '研发管理员',
    userId: 'dev-admin',
    roles: ['SYSTEM_ADMIN'],
  },
  {
    presetId: 'knowledge-editor',
    label: '知识维护者',
    userId: 'knowledge-editor',
    roles: ['KNOWLEDGE_EDITOR'],
  },
  {
    presetId: 'knowledge-reader',
    label: '普通阅读者',
    userId: 'knowledge-reader',
    roles: ['KNOWLEDGE_READER'],
  },
]);

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

/** 为不同配置项创建独立的 CSV Schema，避免复用 CORS 默认值。 */
function csvSchema(
  defaultValue: string,
): z.ZodPipe<z.ZodDefault<z.ZodString>, z.ZodTransform<string[], string>> {
  return z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
}

/** 把 JSON 环境变量解析为 Mock 身份预置，并把语法错误纳入统一配置失败。 */
const MockPresetsSchema = z
  .string()
  .default(defaultMockPresets)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: 'custom', message: '必须是合法 JSON' });
      return z.NEVER;
    }
  })
  .pipe(
    z.array(
      z.object({
        presetId: z.string().trim().min(1).max(64),
        label: z.string().trim().min(1).max(40),
        userId: z.string().trim().min(1).max(128),
        roles: z.array(z.string().trim().min(1).max(128)).min(1),
      }),
    ),
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

    AUTH_MODE: z.enum(authModes).default('mock'),
    AUTH_ROLE_MAPPING_FILE: z.string().min(1).default('config/role-mapping.yaml'),
    AUTH_MOCK_PRESET_ID: z.string().min(1).default('dev-admin'),
    AUTH_MOCK_SELECTION_HEADER: z.string().min(1).default('X-RAG-Mock-User'),
    AUTH_MOCK_PRESETS_JSON: MockPresetsSchema,

    AUTH_USER_HEADER: z.string().min(1).default('X-Authenticated-User'),
    AUTH_ROLES_HEADER: z.string().min(1).default('X-Authenticated-Roles'),
    AUTH_ROLES_SEPARATOR: z.string().min(1).max(4).default(','),
    AUTH_TRUSTED_PROXY_CIDRS: csvSchema('127.0.0.1/32,::1/128'),
    AUTH_HEADER_SIGNATURE_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTH_HEADER_SIGNATURE_SECRET: z.string().default(''),
    AUTH_HEADER_SIGNATURE_HEADER: z.string().min(1).default('X-Auth-Signature'),
    AUTH_HEADER_TIMESTAMP_HEADER: z.string().min(1).default('X-Auth-Timestamp'),
    AUTH_HEADER_MAX_SKEW_SECONDS: z.coerce.number().int().min(5).max(300).default(60),

    AUTH_JWT_JWKS_URL: z.string().default(''),
    AUTH_JWT_ISSUER: z.string().default(''),
    AUTH_JWT_AUDIENCE: z.string().default(''),
    AUTH_JWT_USER_ID_CLAIM: z.string().min(1).default('sub'),
    AUTH_JWT_ROLES_CLAIM: z.string().min(1).default('roles'),
    AUTH_JWT_ALLOWED_ALGORITHMS: csvSchema('RS256'),
  })
  .superRefine((value, context) => {
    if (value.AUTH_MODE === 'mock' && value.APP_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'production 禁止启用 mock 认证',
      });
    }

    if (value.AUTH_MODE === 'trusted-header') {
      if (value.AUTH_TRUSTED_PROXY_CIDRS.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_TRUSTED_PROXY_CIDRS'],
          message: 'Trusted Header 必须声明受信代理网段',
        });
      }
      if (
        value.AUTH_HEADER_SIGNATURE_ENABLED === 'true' &&
        value.AUTH_HEADER_SIGNATURE_SECRET.length < 32
      ) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_HEADER_SIGNATURE_SECRET'],
          message: '启用 Header 签名时密钥至少 32 个字符',
        });
      }
    }

    if (value.AUTH_MODE === 'jwt') {
      const requiredJwtFields = [
        ['AUTH_JWT_JWKS_URL', value.AUTH_JWT_JWKS_URL],
        ['AUTH_JWT_ISSUER', value.AUTH_JWT_ISSUER],
        ['AUTH_JWT_AUDIENCE', value.AUTH_JWT_AUDIENCE],
      ] as const;
      for (const [field, fieldValue] of requiredJwtFields) {
        if (!fieldValue) {
          context.addIssue({ code: 'custom', path: [field], message: 'JWT 模式必须配置' });
        }
      }
      if (value.AUTH_JWT_JWKS_URL && !URL.canParse(value.AUTH_JWT_JWKS_URL)) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_JWT_JWKS_URL'],
          message: '必须是合法 URL',
        });
      }
      if (value.AUTH_JWT_ALLOWED_ALGORITHMS.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_JWT_ALLOWED_ALGORITHMS'],
          message: '至少允许一种明确算法',
        });
      }
    }

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
  auth: {
    mode: (typeof authModes)[number];
    roleMappingFile: string;
    mock: {
      defaultPresetId: string;
      selectionHeader: string;
      presets: readonly {
        presetId: string;
        label: string;
        userId: string;
        roles: readonly string[];
      }[];
    };
    trustedHeader: {
      userHeader: string;
      rolesHeader: string;
      rolesSeparator: string;
      trustedProxyCidrs: readonly string[];
      signatureEnabled: boolean;
      signatureSecret?: string;
      signatureHeader: string;
      timestampHeader: string;
      maxSkewSeconds: number;
    };
    jwt: {
      jwksUrl?: string;
      issuer?: string;
      audience?: string;
      userIdClaim: string;
      rolesClaim: string;
      allowedAlgorithms: readonly string[];
    };
  };
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
    auth: Object.freeze({
      mode: value.AUTH_MODE,
      roleMappingFile: value.AUTH_ROLE_MAPPING_FILE,
      mock: Object.freeze({
        defaultPresetId: value.AUTH_MOCK_PRESET_ID,
        selectionHeader: value.AUTH_MOCK_SELECTION_HEADER.toLowerCase(),
        presets: Object.freeze(
          value.AUTH_MOCK_PRESETS_JSON.map((preset) =>
            Object.freeze({ ...preset, roles: Object.freeze([...preset.roles]) }),
          ),
        ),
      }),
      trustedHeader: Object.freeze({
        userHeader: value.AUTH_USER_HEADER.toLowerCase(),
        rolesHeader: value.AUTH_ROLES_HEADER.toLowerCase(),
        rolesSeparator: value.AUTH_ROLES_SEPARATOR,
        trustedProxyCidrs: Object.freeze([...value.AUTH_TRUSTED_PROXY_CIDRS]),
        signatureEnabled: value.AUTH_HEADER_SIGNATURE_ENABLED === 'true',
        ...(value.AUTH_HEADER_SIGNATURE_SECRET
          ? { signatureSecret: value.AUTH_HEADER_SIGNATURE_SECRET }
          : {}),
        signatureHeader: value.AUTH_HEADER_SIGNATURE_HEADER.toLowerCase(),
        timestampHeader: value.AUTH_HEADER_TIMESTAMP_HEADER.toLowerCase(),
        maxSkewSeconds: value.AUTH_HEADER_MAX_SKEW_SECONDS,
      }),
      jwt: Object.freeze({
        ...(value.AUTH_JWT_JWKS_URL ? { jwksUrl: value.AUTH_JWT_JWKS_URL } : {}),
        ...(value.AUTH_JWT_ISSUER ? { issuer: value.AUTH_JWT_ISSUER } : {}),
        ...(value.AUTH_JWT_AUDIENCE ? { audience: value.AUTH_JWT_AUDIENCE } : {}),
        userIdClaim: value.AUTH_JWT_USER_ID_CLAIM,
        rolesClaim: value.AUTH_JWT_ROLES_CLAIM,
        allowedAlgorithms: Object.freeze([...value.AUTH_JWT_ALLOWED_ALGORITHMS]),
      }),
    }),
  });
}
