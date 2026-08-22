/**
 * 集中定义并校验进程配置。
 * 开发环境提供可安全启动的本地默认值，生产环境禁止默认口令和未加密连接。
 *
 * @requirement BASE-010
 * @requirement CFG-003
 */
import { z } from 'zod';
import { ProviderProfileSchema, type ProviderProfile } from './provider-profile';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const authModes = ['mock', 'trusted-header', 'jwt'] as const;
const scannerAdapters = ['builtin', 'fixture'] as const;
const parserAdapters = ['docling', 'http', 'fixture'] as const;
const ocrAdapters = ['http', 'docling', 'fixture'] as const;
const tokenizerAdapters = ['cl100k'] as const;
const dedupModes = ['RETAIN', 'SUPPRESS'] as const;
const llmAdapters = ['openai-compatible', 'http', 'fixture'] as const;
const embeddingAdapters = ['openai-compatible', 'http', 'fixture'] as const;
const rerankerAdapters = ['http', 'fixture'] as const;
const vectorStoreAdapters = ['milvus', 'memory'] as const;

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

/** 把逗号分隔的 Embedding 输出能力限制为稳定枚举并去重。 */
const EmbeddingOutputModesSchema = z
  .string()
  .default('dense')
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(z.enum(['dense', 'sparse'])).min(1));

/** 生产配置不得把模板占位文本当成真实模型或修订信息。 */
function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return (
    normalized.length === 0 ||
    normalized.includes('请填写') ||
    normalized.includes('changeme') ||
    normalized.includes('todo') ||
    normalized.startsWith('<')
  );
}

/**
 * 内网 Profile 的静态第二道防线。
 * 该判断不能替代防火墙/NetworkPolicy，但能阻止明显公网 Endpoint 被误带入生产配置。
 */
function isPrivateOrClusterUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLocaleLowerCase('en-US');
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.svc') ||
    hostname.includes('.svc.') ||
    !hostname.includes('.')
  ) {
    return true;
  }
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

/** 应用配置的原始环境变量 Schema。 */
export const AppEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['test', 'development', 'staging', 'production']).default('development'),
    PROVIDER_PROFILE: ProviderProfileSchema.default('external-dev'),
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
    MINIO_UPLOAD_BUCKET: z.string().min(3).max(63).default('rag-quarantine'),
    UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
    UPLOAD_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    UPLOAD_MAX_FILES_PER_SESSION: z.coerce.number().int().min(1).max(100).default(100),
    UPLOAD_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(5 * 1024 * 1024 * 1024)
      .default(2 * 1024 * 1024 * 1024),
    UPLOAD_MULTIPART_THRESHOLD_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(5 * 1024 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    UPLOAD_PART_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(5 * 1024 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    INGESTION_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),

    MINIO_DERIVED_BUCKET: z.string().min(3).max(63).default('rag-derived'),
    FILE_STREAM_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
    SCANNER_ADAPTER: z.enum(scannerAdapters).default('builtin'),
    SCANNER_PROFILE_ID: z.string().min(1).max(100).default('builtin-content-safety-v1'),
    SCANNER_REVISION: z.string().min(1).max(100).default('1.0.0'),
    SCANNER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),

    PARSER_ADAPTER: z.enum(parserAdapters).default('http'),
    PARSER_BASE_URL: z.string().url().default('http://localhost:8104'),
    PARSER_API_KEY: z.string().default(''),
    PARSER_PROFILE_ID: z.string().min(1).max(100).default('node-multi-parser-v1'),
    PARSER_REVISION: z.string().min(1).max(100).default('1.0.0'),
    PARSER_PROTOCOL_VERSION: z.string().min(1).max(40).default('2'),
    PARSER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(180_000),
    PARSER_MAX_RESPONSE_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(536_870_912)
      .default(104_857_600),
    PARSER_TEMP_ROOT: z.string().min(1).default('.data/parser-runtime'),
    PARSER_ALLOWED_SOURCE_HOSTS: csvSchema('localhost,127.0.0.1,minio'),
    PARSER_MAX_INPUT_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .max(2 * 1024 * 1024 * 1024)
      .default(256 * 1024 * 1024),
    PARSER_MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(10).max(1_000_000).default(20_000),
    PARSER_MAX_XML_ENTRY_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(512 * 1024 * 1024)
      .default(32 * 1024 * 1024),

    OCR_ADAPTER: z.enum(ocrAdapters).default('docling'),
    OCR_BASE_URL: z.string().url().default('http://localhost:8103'),
    OCR_API_KEY: z.string().default(''),
    OCR_MODEL_ID: z.string().min(1).max(160).default('docling-ocr'),
    OCR_PROFILE_ID: z.string().min(1).max(100).default('docling-ocr-dev-v1'),
    OCR_REVISION: z.string().min(1).max(100).default('docling-serve-v1'),
    OCR_PROTOCOL_VERSION: z.string().min(1).max(40).default('1'),
    OCR_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(180_000),

    FILE_MAX_ARCHIVE_DEPTH: z.coerce.number().int().min(1).max(20).default(3),
    FILE_MAX_COMPRESSION_RATIO: z.coerce.number().min(1).max(10_000).default(100),
    FILE_MAX_PAGES: z.coerce.number().int().min(1).max(20_000).default(2_000),
    FILE_MAX_TOTAL_PIXELS: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(100_000_000_000)
      .default(500_000_000),
    FILE_MAX_TABLE_CELLS: z.coerce.number().int().min(1_000).max(100_000_000).default(5_000_000),
    OCR_TEXT_COVERAGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.02),
    OCR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
    PROCESSING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

    CHUNKER_PROFILE_ID: z.string().min(1).max(100).default('structure-aware-medium-v1'),
    CHUNKER_REVISION: z.string().min(1).max(100).default('1.0.0'),
    TOKENIZER_ADAPTER: z.enum(tokenizerAdapters).default('cl100k'),
    TOKENIZER_PROFILE_ID: z.string().min(1).max(100).default('cl100k-base-local'),
    CHUNK_CHILD_MAX_TOKENS: z.coerce.number().int().min(64).max(8_192).default(512),
    CHUNK_PARENT_MAX_TOKENS: z.coerce.number().int().min(128).max(32_768).default(1_500),
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(2_048).default(64),
    CHUNK_DEDUP_MODE: z.enum(dedupModes).default('SUPPRESS'),
    QUALITY_RULE_VERSION: z.string().min(1).max(100).default('quality-medium-v1'),
    QUALITY_MIN_NON_EMPTY_BLOCK_RATIO: z.coerce.number().min(0).max(1).default(0.6),
    QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO: z.coerce.number().min(0).max(1).default(0.2),
    QUALITY_MIN_OCR_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
    QUALITY_MAX_GARBLED_RATIO: z.coerce.number().min(0).max(1).default(0.03),
    QUALITY_REJECT_GARBLED_RATIO: z.coerce.number().min(0).max(1).default(0.15),
    QUALITY_MAX_DUPLICATE_RATIO: z.coerce.number().min(0).max(1).default(0.4),
    QUALITY_REQUIRE_HEADING_AFTER_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(20),

    LLM_ADAPTER: z.enum(llmAdapters).default('openai-compatible'),
    LLM_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    LLM_API_KEY: z.string().default(''),
    LLM_MODEL_ID: z.string().max(160).default('deepseek-chat'),
    LLM_PROFILE_ID: z.string().min(1).max(100).default('deepseek-external-dev-v1'),
    LLM_REVISION: z.string().max(100).default('deepseek-api-current'),
    LLM_PROTOCOL_VERSION: z.string().min(1).max(40).default('1'),
    LLM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(60_000),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(65_536).default(4_096),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),

    EMBEDDING_ADAPTER: z.enum(embeddingAdapters).default('fixture'),
    EMBEDDING_BASE_URL: z.string().url().default('http://localhost:8101'),
    EMBEDDING_API_KEY: z.string().default(''),
    EMBEDDING_MODEL_ID: z.string().min(1).max(160).default('fixture-embedding'),
    EMBEDDING_PROFILE_ID: z.string().min(1).max(100).default('fixture-embedding-external-dev-v1'),
    EMBEDDING_REVISION: z.string().min(1).max(100).default('1'),
    EMBEDDING_PROTOCOL_VERSION: z.string().min(1).max(40).default('1'),
    EMBEDDING_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
    EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(30_000),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(1_024).default(32),
    EMBEDDING_DENSE_DIMENSION: z.coerce.number().int().min(1).max(65_536).default(1_024),
    EMBEDDING_NORMALIZE_DENSE: z.enum(['true', 'false']).default('true'),
    EMBEDDING_OUTPUT_MODE: EmbeddingOutputModesSchema,
    EMBEDDING_MAX_INPUT_TOKENS: z.coerce.number().int().min(64).max(131_072).default(8_192),

    RERANKER_ADAPTER: z.enum(rerankerAdapters).default('fixture'),
    RERANKER_BASE_URL: z.string().url().default('http://localhost:8102'),
    RERANKER_API_KEY: z.string().default(''),
    RERANKER_MODEL_ID: z.string().min(1).max(160).default('fixture-reranker'),
    RERANKER_PROFILE_ID: z.string().min(1).max(100).default('fixture-reranker-external-dev-v1'),
    RERANKER_REVISION: z.string().min(1).max(100).default('1'),
    RERANKER_PROTOCOL_VERSION: z.string().min(1).max(40).default('1'),
    RERANKER_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
    RERANKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(15_000),
    RERANKER_MAX_CANDIDATES: z.coerce.number().int().min(1).max(1_000).default(50),
    RERANKER_TOP_N: z.coerce.number().int().min(1).max(1_000).default(10),
    RERANKER_MAX_INPUT_TOKENS: z.coerce.number().int().min(64).max(131_072).default(8_192),

    VECTOR_STORE_ADAPTER: z.enum(vectorStoreAdapters).default('milvus'),
    VECTOR_STORE_PROFILE_ID: z.string().min(1).max(100).default('milvus-local-v1'),

    MILVUS_ADDRESS: z.string().min(1).default('localhost:19530'),
    MILVUS_USERNAME: z.string().default(''),
    MILVUS_PASSWORD: z.string().default(''),
    MILVUS_TOKEN: z.string().default(''),
    MILVUS_DATABASE: z.string().min(1).max(100).default('default'),
    MILVUS_TLS_ENABLED: z.enum(['true', 'false']).default('false'),
    MILVUS_COLLECTION_PREFIX: z.string().min(1).max(80).default('rag_chunks'),
    MILVUS_ACTIVE_ALIAS: z.string().min(1).max(100).default('rag_chunks_active'),
    MILVUS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    MILVUS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(30_000),

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
    const expectedEnvironment: Readonly<Record<ProviderProfile, typeof value.APP_ENV>> = {
      test: 'test',
      'external-dev': 'development',
      'external-ci': 'test',
      'intranet-staging': 'staging',
      'intranet-production': 'production',
    };
    if (value.APP_ENV !== expectedEnvironment[value.PROVIDER_PROFILE]) {
      context.addIssue({
        code: 'custom',
        path: ['PROVIDER_PROFILE'],
        message: `${value.PROVIDER_PROFILE} 必须与 APP_ENV=${expectedEnvironment[value.PROVIDER_PROFILE]} 配套`,
      });
    }

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

    if (value.UPLOAD_PRESIGNED_URL_TTL_SECONDS > value.UPLOAD_SESSION_TTL_SECONDS) {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_PRESIGNED_URL_TTL_SECONDS'],
        message: '预签名 URL 有效期不能超过上传会话有效期',
      });
    }

    if (value.CHUNK_PARENT_MAX_TOKENS < value.CHUNK_CHILD_MAX_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['CHUNK_PARENT_MAX_TOKENS'],
        message: 'Parent Token 上限不能小于 Child Token 上限',
      });
    }
    if (value.CHUNK_OVERLAP_TOKENS >= value.CHUNK_CHILD_MAX_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: '重叠 Token 必须小于 Child Token 上限',
      });
    }
    if (value.QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO > value.QUALITY_MIN_NON_EMPTY_BLOCK_RATIO) {
      context.addIssue({
        code: 'custom',
        path: ['QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO'],
        message: '覆盖率拒绝阈值不能高于人工复核阈值',
      });
    }
    if (value.QUALITY_REJECT_GARBLED_RATIO < value.QUALITY_MAX_GARBLED_RATIO) {
      context.addIssue({
        code: 'custom',
        path: ['QUALITY_REJECT_GARBLED_RATIO'],
        message: '乱码拒绝阈值不能低于人工复核阈值',
      });
    }

    if (value.RERANKER_TOP_N > value.RERANKER_MAX_CANDIDATES) {
      context.addIssue({
        code: 'custom',
        path: ['RERANKER_TOP_N'],
        message: 'Reranker TopN 不能大于最大候选数',
      });
    }
    if (value.CHUNK_CHILD_MAX_TOKENS >= value.EMBEDDING_MAX_INPUT_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['CHUNK_CHILD_MAX_TOKENS'],
        message: 'Child Token 上限必须小于 Embedding 最大输入 Token',
      });
    }
    if (value.CHUNK_CHILD_MAX_TOKENS >= value.RERANKER_MAX_INPUT_TOKENS) {
      context.addIssue({
        code: 'custom',
        path: ['CHUNK_CHILD_MAX_TOKENS'],
        message: 'Child Token 上限必须小于 Reranker 最大输入 Token',
      });
    }
    if (value.OCR_MIN_CONFIDENCE !== value.QUALITY_MIN_OCR_CONFIDENCE) {
      context.addIssue({
        code: 'custom',
        path: ['QUALITY_MIN_OCR_CONFIDENCE'],
        message: 'OCR 与质量门禁的最低置信度必须保持一致',
      });
    }

    const isIsolatedTest =
      value.PROVIDER_PROFILE === 'test' || value.PROVIDER_PROFILE === 'external-ci';
    if (isIsolatedTest) {
      const nonDeterministicFields: string[] = [];
      if (value.SCANNER_ADAPTER !== 'fixture') nonDeterministicFields.push('SCANNER_ADAPTER');
      if (value.PARSER_ADAPTER !== 'fixture') nonDeterministicFields.push('PARSER_ADAPTER');
      if (value.OCR_ADAPTER !== 'fixture') nonDeterministicFields.push('OCR_ADAPTER');
      if (value.LLM_ADAPTER !== 'fixture') nonDeterministicFields.push('LLM_ADAPTER');
      if (value.EMBEDDING_ADAPTER !== 'fixture') {
        nonDeterministicFields.push('EMBEDDING_ADAPTER');
      }
      if (value.RERANKER_ADAPTER !== 'fixture') nonDeterministicFields.push('RERANKER_ADAPTER');
      if (value.VECTOR_STORE_ADAPTER !== 'memory') {
        nonDeterministicFields.push('VECTOR_STORE_ADAPTER');
      }
      if (nonDeterministicFields.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['PROVIDER_PROFILE'],
          message: `test/CI Profile 禁止依赖实时或公网 Provider：${nonDeterministicFields.join(', ')}`,
        });
      }
    }

    const isIntranet =
      value.PROVIDER_PROFILE === 'intranet-staging' ||
      value.PROVIDER_PROFILE === 'intranet-production';
    if (isIntranet) {
      const unsafeIntranetFields: string[] = [];
      if (value.AUTH_MODE === 'mock') unsafeIntranetFields.push('AUTH_MODE');
      if (value.SCANNER_ADAPTER === 'fixture') unsafeIntranetFields.push('SCANNER_ADAPTER');
      if (value.PARSER_ADAPTER !== 'http') unsafeIntranetFields.push('PARSER_ADAPTER');
      if (value.OCR_ADAPTER !== 'http') unsafeIntranetFields.push('OCR_ADAPTER');
      if (value.LLM_ADAPTER === 'fixture') unsafeIntranetFields.push('LLM_ADAPTER');
      if (value.EMBEDDING_ADAPTER === 'fixture') unsafeIntranetFields.push('EMBEDDING_ADAPTER');
      if (value.RERANKER_ADAPTER === 'fixture') unsafeIntranetFields.push('RERANKER_ADAPTER');
      if (value.VECTOR_STORE_ADAPTER !== 'milvus') {
        unsafeIntranetFields.push('VECTOR_STORE_ADAPTER');
      }
      if (value.EMBEDDING_DENSE_DIMENSION !== 1_024) {
        unsafeIntranetFields.push('EMBEDDING_DENSE_DIMENSION');
      }
      if (!value.EMBEDDING_OUTPUT_MODE.includes('sparse')) {
        unsafeIntranetFields.push('EMBEDDING_OUTPUT_MODE');
      }

      const requiredIdentityFields = [
        ['SCANNER_PROFILE_ID', value.SCANNER_PROFILE_ID],
        ['SCANNER_REVISION', value.SCANNER_REVISION],
        ['PARSER_PROFILE_ID', value.PARSER_PROFILE_ID],
        ['PARSER_REVISION', value.PARSER_REVISION],
        ['OCR_MODEL_ID', value.OCR_MODEL_ID],
        ['OCR_PROFILE_ID', value.OCR_PROFILE_ID],
        ['OCR_REVISION', value.OCR_REVISION],
        ['LLM_MODEL_ID', value.LLM_MODEL_ID],
        ['LLM_PROFILE_ID', value.LLM_PROFILE_ID],
        ['LLM_REVISION', value.LLM_REVISION],
        ['EMBEDDING_MODEL_ID', value.EMBEDDING_MODEL_ID],
        ['EMBEDDING_PROFILE_ID', value.EMBEDDING_PROFILE_ID],
        ['EMBEDDING_REVISION', value.EMBEDDING_REVISION],
        ['RERANKER_MODEL_ID', value.RERANKER_MODEL_ID],
        ['RERANKER_PROFILE_ID', value.RERANKER_PROFILE_ID],
        ['RERANKER_REVISION', value.RERANKER_REVISION],
        ['VECTOR_STORE_PROFILE_ID', value.VECTOR_STORE_PROFILE_ID],
      ] as const;
      for (const [field, fieldValue] of requiredIdentityFields) {
        if (isPlaceholder(fieldValue)) unsafeIntranetFields.push(field);
      }

      const providerUrls = [
        ['PARSER_BASE_URL', value.PARSER_BASE_URL],
        ['OCR_BASE_URL', value.OCR_BASE_URL],
        ['LLM_BASE_URL', value.LLM_BASE_URL],
        ['EMBEDDING_BASE_URL', value.EMBEDDING_BASE_URL],
        ['RERANKER_BASE_URL', value.RERANKER_BASE_URL],
      ] as const;
      for (const [field, url] of providerUrls) {
        if (!isPrivateOrClusterUrl(url)) unsafeIntranetFields.push(field);
      }
      const milvusUrl = value.MILVUS_ADDRESS.includes('://')
        ? value.MILVUS_ADDRESS
        : `tcp://${value.MILVUS_ADDRESS}`;
      if (!isPrivateOrClusterUrl(milvusUrl)) unsafeIntranetFields.push('MILVUS_ADDRESS');

      if (unsafeIntranetFields.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['PROVIDER_PROFILE'],
          message: `内网 Profile 存在不安全、占位或不兼容配置：${[
            ...new Set(unsafeIntranetFields),
          ].join(', ')}`,
        });
      }
    }

    if (value.APP_ENV !== 'production') return;

    const insecureReasons: string[] = [];
    if (value.DATABASE_URL.includes('rag-local-only')) insecureReasons.push('DATABASE_URL');
    if (value.MINIO_ACCESS_KEY === 'rag-local') insecureReasons.push('MINIO_ACCESS_KEY');
    if (value.MINIO_SECRET_KEY === 'rag-local-secret') insecureReasons.push('MINIO_SECRET_KEY');
    if (isPlaceholder(value.MINIO_ACCESS_KEY)) insecureReasons.push('MINIO_ACCESS_KEY_PLACEHOLDER');
    if (isPlaceholder(value.MINIO_SECRET_KEY)) insecureReasons.push('MINIO_SECRET_KEY_PLACEHOLDER');
    if (/changeme|请填写|todo/iu.test(value.DATABASE_URL)) {
      insecureReasons.push('DATABASE_URL_PLACEHOLDER');
    }
    if (!value.DATABASE_URL.includes('sslmode=')) insecureReasons.push('DATABASE_URL_SSL');
    if (value.SCANNER_ADAPTER === 'fixture') insecureReasons.push('SCANNER_ADAPTER');
    if (value.PARSER_ADAPTER === 'fixture') insecureReasons.push('PARSER_ADAPTER');
    if (value.PARSER_ADAPTER === 'docling') insecureReasons.push('PARSER_ADAPTER_STRUCTURE_SCAN');
    if (value.OCR_ADAPTER === 'fixture') insecureReasons.push('OCR_ADAPTER');
    if (value.LLM_ADAPTER === 'fixture') insecureReasons.push('LLM_ADAPTER');
    if (value.EMBEDDING_ADAPTER === 'fixture') insecureReasons.push('EMBEDDING_ADAPTER');
    if (value.RERANKER_ADAPTER === 'fixture') insecureReasons.push('RERANKER_ADAPTER');
    if (value.VECTOR_STORE_ADAPTER === 'memory') insecureReasons.push('VECTOR_STORE_ADAPTER');

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
  providerProfile: ProviderProfile;
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
    uploadBucket: string;
  };
  upload: {
    sessionTtlSeconds: number;
    presignedUrlTtlSeconds: number;
    maxFilesPerSession: number;
    maxFileBytes: number;
    multipartThresholdBytes: number;
    partSizeBytes: number;
    ingestionLeaseSeconds: number;
  };
  fileProcessing: {
    derivedBucket: string;
    streamTimeoutMs: number;
    scanner: {
      adapter: (typeof scannerAdapters)[number];
      profileId: string;
      revision: string;
      timeoutMs: number;
    };
    parser: {
      adapter: (typeof parserAdapters)[number];
      baseUrl: string;
      apiKey?: string;
      profileId: string;
      revision: string;
      protocolVersion: string;
      timeoutMs: number;
      maxResponseBytes: number;
      tempRoot: string;
      allowedSourceHosts: readonly string[];
      maxInputBytes: number;
      maxArchiveEntries: number;
      maxXmlEntryBytes: number;
    };
    ocr: {
      adapter: (typeof ocrAdapters)[number];
      baseUrl: string;
      apiKey?: string;
      modelId: string;
      profileId: string;
      revision: string;
      protocolVersion: string;
      timeoutMs: number;
    };
    limits: {
      maxArchiveDepth: number;
      maxCompressionRatio: number;
      maxPages: number;
      maxTotalPixels: number;
      maxTableCells: number;
      ocrTextCoverageThreshold: number;
      ocrMinConfidence: number;
      maxAttempts: number;
    };
  };
  knowledgeProcessing: {
    chunkerProfileId: string;
    chunkerRevision: string;
    tokenizerAdapter: (typeof tokenizerAdapters)[number];
    tokenizerProfileId: string;
    childMaxTokens: number;
    parentMaxTokens: number;
    overlapTokens: number;
    dedupMode: (typeof dedupModes)[number];
    qualityRuleVersion: string;
    minimumNonEmptyBlockRatio: number;
    rejectNonEmptyBlockRatio: number;
    minimumOcrConfidence: number;
    maximumGarbledRatio: number;
    rejectGarbledRatio: number;
    maximumDuplicateRatio: number;
    requireHeadingAfterBlocks: number;
  };
  llm: {
    adapter: (typeof llmAdapters)[number];
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    profileId: string;
    revision: string;
    protocolVersion: string;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    maxOutputTokens: number;
    temperature: number;
  };
  embedding: {
    adapter: (typeof embeddingAdapters)[number];
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    profileId: string;
    revision: string;
    protocolVersion: string;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    batchSize: number;
    denseDimension: number;
    normalizeDense: boolean;
    outputModes: readonly ('dense' | 'sparse')[];
    maxInputTokens: number;
  };
  reranker: {
    adapter: (typeof rerankerAdapters)[number];
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    profileId: string;
    revision: string;
    protocolVersion: string;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    maxCandidates: number;
    topN: number;
    maxInputTokens: number;
  };
  vectorStore: {
    adapter: (typeof vectorStoreAdapters)[number];
    profileId: string;
  };
  milvus: {
    address: string;
    username?: string;
    password?: string;
    token?: string;
    database: string;
    tlsEnabled: boolean;
    collectionPrefix: string;
    activeAlias: string;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
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
    providerProfile: value.PROVIDER_PROFILE,
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
      uploadBucket: value.MINIO_UPLOAD_BUCKET,
    }),
    upload: Object.freeze({
      sessionTtlSeconds: value.UPLOAD_SESSION_TTL_SECONDS,
      presignedUrlTtlSeconds: value.UPLOAD_PRESIGNED_URL_TTL_SECONDS,
      maxFilesPerSession: value.UPLOAD_MAX_FILES_PER_SESSION,
      maxFileBytes: value.UPLOAD_MAX_FILE_BYTES,
      multipartThresholdBytes: value.UPLOAD_MULTIPART_THRESHOLD_BYTES,
      partSizeBytes: value.UPLOAD_PART_SIZE_BYTES,
      ingestionLeaseSeconds: value.INGESTION_LEASE_SECONDS,
    }),
    fileProcessing: Object.freeze({
      derivedBucket: value.MINIO_DERIVED_BUCKET,
      streamTimeoutMs: value.FILE_STREAM_TIMEOUT_MS,
      scanner: Object.freeze({
        adapter: value.SCANNER_ADAPTER,
        profileId: value.SCANNER_PROFILE_ID,
        revision: value.SCANNER_REVISION,
        timeoutMs: value.SCANNER_REQUEST_TIMEOUT_MS,
      }),
      parser: Object.freeze({
        adapter: value.PARSER_ADAPTER,
        baseUrl: value.PARSER_BASE_URL,
        ...(value.PARSER_API_KEY ? { apiKey: value.PARSER_API_KEY } : {}),
        profileId: value.PARSER_PROFILE_ID,
        revision: value.PARSER_REVISION,
        protocolVersion: value.PARSER_PROTOCOL_VERSION,
        timeoutMs: value.PARSER_REQUEST_TIMEOUT_MS,
        maxResponseBytes: value.PARSER_MAX_RESPONSE_BYTES,
        tempRoot: value.PARSER_TEMP_ROOT,
        allowedSourceHosts: value.PARSER_ALLOWED_SOURCE_HOSTS,
        maxInputBytes: value.PARSER_MAX_INPUT_BYTES,
        maxArchiveEntries: value.PARSER_MAX_ARCHIVE_ENTRIES,
        maxXmlEntryBytes: value.PARSER_MAX_XML_ENTRY_BYTES,
      }),
      ocr: Object.freeze({
        adapter: value.OCR_ADAPTER,
        baseUrl: value.OCR_BASE_URL,
        ...(value.OCR_API_KEY ? { apiKey: value.OCR_API_KEY } : {}),
        modelId: value.OCR_MODEL_ID,
        profileId: value.OCR_PROFILE_ID,
        revision: value.OCR_REVISION,
        protocolVersion: value.OCR_PROTOCOL_VERSION,
        timeoutMs: value.OCR_REQUEST_TIMEOUT_MS,
      }),
      limits: Object.freeze({
        maxArchiveDepth: value.FILE_MAX_ARCHIVE_DEPTH,
        maxCompressionRatio: value.FILE_MAX_COMPRESSION_RATIO,
        maxPages: value.FILE_MAX_PAGES,
        maxTotalPixels: value.FILE_MAX_TOTAL_PIXELS,
        maxTableCells: value.FILE_MAX_TABLE_CELLS,
        ocrTextCoverageThreshold: value.OCR_TEXT_COVERAGE_THRESHOLD,
        ocrMinConfidence: value.OCR_MIN_CONFIDENCE,
        maxAttempts: value.PROCESSING_MAX_ATTEMPTS,
      }),
    }),
    knowledgeProcessing: Object.freeze({
      chunkerProfileId: value.CHUNKER_PROFILE_ID,
      chunkerRevision: value.CHUNKER_REVISION,
      tokenizerAdapter: value.TOKENIZER_ADAPTER,
      tokenizerProfileId: value.TOKENIZER_PROFILE_ID,
      childMaxTokens: value.CHUNK_CHILD_MAX_TOKENS,
      parentMaxTokens: value.CHUNK_PARENT_MAX_TOKENS,
      overlapTokens: value.CHUNK_OVERLAP_TOKENS,
      dedupMode: value.CHUNK_DEDUP_MODE,
      qualityRuleVersion: value.QUALITY_RULE_VERSION,
      minimumNonEmptyBlockRatio: value.QUALITY_MIN_NON_EMPTY_BLOCK_RATIO,
      rejectNonEmptyBlockRatio: value.QUALITY_REJECT_NON_EMPTY_BLOCK_RATIO,
      minimumOcrConfidence: value.QUALITY_MIN_OCR_CONFIDENCE,
      maximumGarbledRatio: value.QUALITY_MAX_GARBLED_RATIO,
      rejectGarbledRatio: value.QUALITY_REJECT_GARBLED_RATIO,
      maximumDuplicateRatio: value.QUALITY_MAX_DUPLICATE_RATIO,
      requireHeadingAfterBlocks: value.QUALITY_REQUIRE_HEADING_AFTER_BLOCKS,
    }),
    llm: Object.freeze({
      adapter: value.LLM_ADAPTER,
      baseUrl: value.LLM_BASE_URL,
      ...(value.LLM_API_KEY ? { apiKey: value.LLM_API_KEY } : {}),
      modelId: value.LLM_MODEL_ID,
      profileId: value.LLM_PROFILE_ID,
      revision: value.LLM_REVISION,
      protocolVersion: value.LLM_PROTOCOL_VERSION,
      connectTimeoutMs: value.LLM_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: value.LLM_REQUEST_TIMEOUT_MS,
      maxOutputTokens: value.LLM_MAX_OUTPUT_TOKENS,
      temperature: value.LLM_TEMPERATURE,
    }),
    embedding: Object.freeze({
      adapter: value.EMBEDDING_ADAPTER,
      baseUrl: value.EMBEDDING_BASE_URL,
      ...(value.EMBEDDING_API_KEY ? { apiKey: value.EMBEDDING_API_KEY } : {}),
      modelId: value.EMBEDDING_MODEL_ID,
      profileId: value.EMBEDDING_PROFILE_ID,
      revision: value.EMBEDDING_REVISION,
      protocolVersion: value.EMBEDDING_PROTOCOL_VERSION,
      connectTimeoutMs: value.EMBEDDING_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: value.EMBEDDING_REQUEST_TIMEOUT_MS,
      batchSize: value.EMBEDDING_BATCH_SIZE,
      denseDimension: value.EMBEDDING_DENSE_DIMENSION,
      normalizeDense: value.EMBEDDING_NORMALIZE_DENSE === 'true',
      outputModes: Object.freeze([...value.EMBEDDING_OUTPUT_MODE]),
      maxInputTokens: value.EMBEDDING_MAX_INPUT_TOKENS,
    }),
    reranker: Object.freeze({
      adapter: value.RERANKER_ADAPTER,
      baseUrl: value.RERANKER_BASE_URL,
      ...(value.RERANKER_API_KEY ? { apiKey: value.RERANKER_API_KEY } : {}),
      modelId: value.RERANKER_MODEL_ID,
      profileId: value.RERANKER_PROFILE_ID,
      revision: value.RERANKER_REVISION,
      protocolVersion: value.RERANKER_PROTOCOL_VERSION,
      connectTimeoutMs: value.RERANKER_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: value.RERANKER_REQUEST_TIMEOUT_MS,
      maxCandidates: value.RERANKER_MAX_CANDIDATES,
      topN: value.RERANKER_TOP_N,
      maxInputTokens: value.RERANKER_MAX_INPUT_TOKENS,
    }),
    vectorStore: Object.freeze({
      adapter: value.VECTOR_STORE_ADAPTER,
      profileId: value.VECTOR_STORE_PROFILE_ID,
    }),
    milvus: Object.freeze({
      address: value.MILVUS_ADDRESS,
      ...(value.MILVUS_USERNAME ? { username: value.MILVUS_USERNAME } : {}),
      ...(value.MILVUS_PASSWORD ? { password: value.MILVUS_PASSWORD } : {}),
      ...(value.MILVUS_TOKEN ? { token: value.MILVUS_TOKEN } : {}),
      database: value.MILVUS_DATABASE,
      tlsEnabled: value.MILVUS_TLS_ENABLED === 'true',
      collectionPrefix: value.MILVUS_COLLECTION_PREFIX,
      activeAlias: value.MILVUS_ACTIVE_ALIAS,
      connectTimeoutMs: value.MILVUS_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: value.MILVUS_REQUEST_TIMEOUT_MS,
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
