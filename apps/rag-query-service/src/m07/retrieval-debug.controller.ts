/**
 * M07 授权检索调试 HTTP Adapter。
 *
 * Controller 只校验 runId、映射可信 UserContext 并调用用例；角色与 owner 判定在应用服务中默认拒绝。
 * 响应只包含排名、分数、主键和移除原因统计，不包含问题或 Chunk 正文。
 *
 * @requirement RET-016
 */
import { Controller, Inject, Param, Post } from '@nestjs/common';
import { CurrentUser } from '@rag/auth';
import type { ApiEnvelope, RetrievalDebugResult, UserContext } from '@rag/contracts';
import { M07RetrievalService } from '@rag/rag-graph';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { parseM06Input, toAccessContext } from '../m06/m06-http-utils';

const RunIdSchema = z.uuid();

/** 管理员/审计员的 Run 级检索调试入口。 */
@Controller('runs')
export class RetrievalDebugController {
  public constructor(
    @Inject(M07RetrievalService) private readonly retrieval: M07RetrievalService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 执行 M07 子图并返回脱敏调试结果；POST 明确表达会产生 Provider 查询。 */
  @Post(':runId/retrieval-debug')
  public async execute(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
  ): Promise<ApiEnvelope<RetrievalDebugResult>> {
    const data = await this.retrieval.debug(
      toAccessContext(user, this.requestContext),
      parseM06Input(RunIdSchema, rawRunId),
    );
    const traceId = this.requestContext.get()?.traceId;
    return {
      data,
      requestId: this.requestContext.getRequestId(),
      ...(traceId ? { traceId } : {}),
    };
  }
}
