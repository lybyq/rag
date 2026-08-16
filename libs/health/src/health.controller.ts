/** HTTP 应用健康端点；Worker 使用独立的轻量 Probe Server 复用同一 HealthService。 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { ApiEnvelope, ServiceHealthData } from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import type { Response } from 'express';
import { HealthService } from './health.service';

/** 对外提供 Kubernetes/负载均衡器可消费的存活和就绪接口。 */
@Controller('health')
export class HealthController {
  public constructor(
    @Inject(HealthService) private readonly healthService: HealthService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 存活检查不访问外部依赖，避免依赖抖动导致进程被错误重启。 */
  @Get('live')
  public liveness(): ApiEnvelope<ServiceHealthData> {
    const context = this.requestContext.get();
    return {
      requestId: context?.requestId ?? this.requestContext.getRequestId(),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
      data: this.healthService.liveness(),
    };
  }

  /** 就绪检查根据依赖状态返回 200 或 503，并保留结构化状态供诊断。 */
  @Get('ready')
  public async readiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiEnvelope<ServiceHealthData>> {
    const data = await this.healthService.readiness();
    response.status(data.status === 'up' ? 200 : 503);
    const context = this.requestContext.get();
    return {
      requestId: context?.requestId ?? this.requestContext.getRequestId(),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
      data,
    };
  }
}
