/**
 * 证据、生成与答案校验 引用预览 HTTP Adapter。
 *
 * citationId 是不透明 UUID；Controller 只校验输入和映射可信身份，Repository 每次读取都会
 * 重新验证 owner、ACL、文档版本、Manifest 与生效时间，并仅返回最小摘录。
 *
 * @requirement ANS-017
 */
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { RagRunService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import type { ApiEnvelope, CitationPreview, UserContext } from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import {
  parseConversationInput,
  toAccessContext,
} from '../conversation-runtime/conversation-http-utils';

const CitationIdSchema = z.uuid();

/** 当前用户的最小引用预览入口。 */
@Controller('citations')
export class CitationsController {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 获取经当前权限重新复核的引用摘录。 */
  @Get(':citationId')
  public async getPreview(
    @CurrentUser() user: UserContext,
    @Param('citationId') rawCitationId: string,
  ): Promise<ApiEnvelope<CitationPreview>> {
    const data = await this.runs.getCitationPreview(
      toAccessContext(user, this.requestContext),
      parseConversationInput(CitationIdSchema, rawCitationId),
    );
    const traceId = this.requestContext.get()?.traceId;
    return {
      data,
      requestId: this.requestContext.getRequestId(),
      ...(traceId ? { traceId } : {}),
    };
  }
}
