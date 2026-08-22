/**
 * M06 会话、消息、Run 创建与反馈 HTTP Adapter。
 * Controller 只做 Zod 映射、可信 Header 读取和 Use Case 调用，不同步执行模型。
 *
 * @requirement RUN-002
 * @requirement RUN-003
 * @requirement RUN-012
 * @requirement RUN-013
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { RagRunService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CreateConversationRequestSchema,
  CreateMessageFeedbackRequestSchema,
  CreateRagRunRequestSchema,
  ListConversationsQuerySchema,
  type ApiEnvelope,
  type Conversation,
  type ConversationMessage,
  type ConversationState,
  type CreateRagRunAccepted,
  type MessageFeedback,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { parseM06Input, toAccessContext } from './m06-http-utils';

const IdSchema = z.uuid();

/** 会话与会话内 Run API。 */
@Controller('conversations')
export class ConversationsController {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 创建会话。 */
  @Post()
  public async create(
    @CurrentUser() user: UserContext,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<Conversation>> {
    return this.envelope(
      await this.runs.createConversation(
        toAccessContext(user, this.requestContext),
        parseM06Input(CreateConversationRequestSchema, rawBody),
      ),
    );
  }

  /** 分页列出当前用户会话。 */
  @Get()
  public async list(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly Conversation[]; nextCursor: string | null }>> {
    return this.envelope(
      await this.runs.listConversations(
        toAccessContext(user, this.requestContext),
        parseM06Input(ListConversationsQuerySchema, rawQuery),
      ),
    );
  }

  /** 读取短窗口与会话摘要，历史引用会重新鉴权。 */
  @Get(':conversationId/messages')
  public async messages(
    @CurrentUser() user: UserContext,
    @Param('conversationId') rawConversationId: string,
  ): Promise<
    ApiEnvelope<{
      readonly items: readonly ConversationMessage[];
      readonly state: ConversationState;
    }>
  > {
    return this.envelope(
      await this.runs.listMessages(
        toAccessContext(user, this.requestContext),
        parseM06Input(IdSchema, rawConversationId),
      ),
    );
  }

  /** Idempotency-Key 必须由客户端为一次逻辑提问稳定生成。 */
  @Post(':conversationId/runs')
  @HttpCode(202)
  public async createRun(
    @CurrentUser() user: UserContext,
    @Param('conversationId') rawConversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<CreateRagRunAccepted>> {
    const key = parseM06Input(z.string().min(8).max(200), idempotencyKey);
    return this.envelope(
      await this.runs.createRun(
        toAccessContext(user, this.requestContext),
        parseM06Input(IdSchema, rawConversationId),
        key,
        parseM06Input(CreateRagRunRequestSchema, rawBody),
      ),
    );
  }

  private envelope<T>(data: T): ApiEnvelope<T> {
    const traceId = this.requestContext.get()?.traceId;
    return {
      data,
      requestId: this.requestContext.getRequestId(),
      ...(traceId ? { traceId } : {}),
    };
  }
}

/** 消息反馈 API 与会话路由分离，便于后续评测权限控制。 */
@Controller('messages')
export class MessageFeedbackController {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 对自己的可见助手消息新增或覆盖反馈。 */
  @Post(':messageId/feedback')
  public async save(
    @CurrentUser() user: UserContext,
    @Param('messageId') rawMessageId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<MessageFeedback>> {
    const data = await this.runs.saveFeedback(
      toAccessContext(user, this.requestContext),
      parseM06Input(IdSchema, rawMessageId),
      parseM06Input(CreateMessageFeedbackRequestSchema, rawBody),
    );
    const traceId = this.requestContext.get()?.traceId;
    return {
      data,
      requestId: this.requestContext.getRequestId(),
      ...(traceId ? { traceId } : {}),
    };
  }
}
