/**
 * Platform API 的运行健康与 Provider/Profile 公开 Adapter。
 *
 * 健康数据来自协议探针和 PostgreSQL 实例心跳；Provider 视图从已校验 AppConfig 生成，
 * 只展示 endpoint host 和“是否配置凭据”，绝不返回 URL 路径、Token 或密钥。
 *
 * @requirement OPS-005
 * @requirement WEB-024
 */
import { Inject, Injectable } from '@nestjs/common';
import type { ProviderOperationsPort, RuntimeOperationsPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import {
  OperationalComponentSchema,
  ProviderProfileStatusSchema,
  type OperationalComponent,
  type ProviderProfileStatus,
} from '@rag/contracts';
import { HealthService } from '@rag/health';
import { POSTGRES_POOL } from '@rag/persistence-pg';
import type { Pool } from 'pg';

interface HeartbeatRow {
  service_name: string;
  service_kind: 'API' | 'WORKER';
  last_seen_at: Date;
  instance_count: number;
}

const expectedServices = [
  ['platform-api', 'API'],
  ['rag-query-service', 'API'],
  ['ingestion-worker', 'WORKER'],
  ['scheduler-worker', 'WORKER'],
  ['document-parser-service', 'API'],
] as const;

/** 健康和 Provider 状态 Adapter。 */
@Injectable()
export class PlatformRuntimeOperationsAdapter
  implements RuntimeOperationsPort, ProviderOperationsPort
{
  public constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
  ) {}

  /** 基础设施协议探针与服务实例心跳合并为统一组件列表。 */
  public async listComponents(): Promise<readonly OperationalComponent[]> {
    const [readiness, heartbeatResult] = await Promise.all([
      this.health.readiness(),
      this.pool.query<HeartbeatRow>(
        `SELECT service_name,service_kind,max(last_seen_at) AS last_seen_at,
                count(*) FILTER (WHERE last_seen_at>=now()-interval '30 seconds')::integer AS instance_count
           FROM service_instance_heartbeats GROUP BY service_name,service_kind`,
      ),
    ]);
    const now = new Date();
    const heartbeatByName = new Map(heartbeatResult.rows.map((row) => [row.service_name, row]));
    const services = expectedServices.map(([service, kind]) => {
      const heartbeat = heartbeatByName.get(service);
      const fresh = heartbeat && now.getTime() - heartbeat.last_seen_at.getTime() <= 30_000;
      return OperationalComponentSchema.parse({
        key: `service:${service}`,
        label: service,
        kind,
        status: fresh ? 'UP' : heartbeat ? 'DOWN' : 'UNKNOWN',
        latencyMs: null,
        message: fresh
          ? `${heartbeat.instance_count} 个实例正在上报`
          : heartbeat
            ? '实例心跳已过期'
            : '尚未收到实例心跳',
        checkedAt: now.toISOString(),
        metadata: { instanceCount: heartbeat?.instance_count ?? 0 },
      });
    });
    const dependencies = readiness.dependencies.map((dependency) =>
      OperationalComponentSchema.parse({
        key: `dependency:${dependency.name}`,
        label: dependency.name,
        kind: dependencyKind(dependency.name),
        status: dependency.status === 'up' ? 'UP' : 'DOWN',
        latencyMs: dependency.latencyMs,
        message: dependency.message,
        checkedAt: readiness.checkedAt,
        metadata: {},
      }),
    );
    return [...services, ...dependencies];
  }

  /** 从启动已校验配置构造非敏感 Provider/Profile 列表。 */
  public async listProviderProfiles(): Promise<readonly ProviderProfileStatus[]> {
    const values = [
      profile(
        'LLM',
        this.config.llm.adapter,
        this.config.llm.profileId,
        this.config.llm.modelId,
        this.config.llm.revision,
        this.config.llm.protocolVersion,
        this.config.llm.baseUrl,
        Boolean(this.config.llm.apiKey),
      ),
      profile(
        'EMBEDDING',
        this.config.embedding.adapter,
        this.config.embedding.profileId,
        this.config.embedding.modelId,
        this.config.embedding.revision,
        this.config.embedding.protocolVersion,
        this.config.embedding.baseUrl,
        Boolean(this.config.embedding.apiKey),
      ),
      profile(
        'RERANKER',
        this.config.reranker.adapter,
        this.config.reranker.profileId,
        this.config.reranker.modelId,
        this.config.reranker.revision,
        this.config.reranker.protocolVersion,
        this.config.reranker.baseUrl,
        Boolean(this.config.reranker.apiKey),
      ),
      profile(
        'OCR',
        this.config.fileProcessing.ocr.adapter,
        this.config.fileProcessing.ocr.profileId,
        this.config.fileProcessing.ocr.modelId,
        this.config.fileProcessing.ocr.revision,
        this.config.fileProcessing.ocr.protocolVersion,
        this.config.fileProcessing.ocr.baseUrl,
        Boolean(this.config.fileProcessing.ocr.apiKey),
      ),
      profile(
        'PARSER',
        this.config.fileProcessing.parser.adapter,
        this.config.fileProcessing.parser.profileId,
        null,
        this.config.fileProcessing.parser.revision,
        this.config.fileProcessing.parser.protocolVersion,
        this.config.fileProcessing.parser.baseUrl,
        Boolean(this.config.fileProcessing.parser.apiKey),
      ),
      profile(
        'VECTOR_STORE',
        this.config.vectorStore.adapter,
        this.config.vectorStore.profileId,
        null,
        'registry',
        'milvus-v1',
        this.config.milvus.address,
        Boolean(this.config.milvus.token || this.config.milvus.password),
      ),
    ];
    return Promise.resolve(values);
  }
}

function profile(
  capability: ProviderProfileStatus['capability'],
  adapter: string,
  profileId: string,
  modelId: string | null,
  revision: string,
  protocolVersion: string,
  endpoint: string,
  credentialConfigured: boolean,
): ProviderProfileStatus {
  const fixture = adapter === 'fixture' || adapter === 'local';
  return ProviderProfileStatusSchema.parse({
    capability,
    adapter,
    profileId,
    modelId,
    revision,
    protocolVersion,
    endpointHost: safeHost(endpoint),
    credentialConfigured,
    health: fixture ? 'UP' : 'UNKNOWN',
    compatibilityMessage: fixture ? '本地实现已就绪' : '实际兼容性以启动握手和就绪探针为准',
  });
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint.includes('://') ? endpoint : `tcp://${endpoint}`).host;
  } catch {
    return 'configured-endpoint';
  }
}

function dependencyKind(name: string): OperationalComponent['kind'] {
  const normalized = name.toLocaleLowerCase('en-US');
  if (normalized.includes('postgres')) return 'POSTGRES';
  if (normalized.includes('redis')) return 'REDIS';
  if (normalized.includes('minio')) return 'MINIO';
  if (normalized.includes('milvus')) return 'MILVUS';
  return 'API';
}
