/**
 * M06 Run 详情、取消、轮询、SSE 与一次性 Ticket HTTP Adapter。
 * SSE 只投影 Redis 中已持久化事件；慢客户端等待 drain 超时后主动断开，客户端可携带 Last-Event-ID 重连。
 *
 * @requirement RUN-008
 * @requirement RUN-009
 * @requirement RUN-010
 * @requirement RUN-013
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RagRunService } from '@rag/application';
import { CurrentUser, PublicRoute } from '@rag/auth';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import {
  CancelRagRunRequestSchema,
  type ApiEnvelope,
  type RagRun,
  type RagRunEventPage,
  type RagRunStep,
  type RunStreamTicket,
  type UserContext,
} from '@rag/contracts';
import { MetricsService, RequestContextService } from '@rag/observability';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseM06Input, readCookie, toAccessContext } from './m06-http-utils';

const IdSchema = z.uuid();
const TicketSchema = z.string().min(32).max(256);
const EventPollSchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const ticketCookieName = 'rag_stream_ticket';

/** 已认证 Run 管理与事件入口。 */
@Controller('runs')
export class RunsController {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** Run 详情在 Stream 过期后仍是最终降级事实。 */
  @Get(':runId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
  ): Promise<ApiEnvelope<RagRun>> {
    return this.envelope(
      await this.runs.getRun(
        toAccessContext(user, this.requestContext),
        parseM06Input(IdSchema, rawRunId),
      ),
    );
  }

  /** Graph 节点只返回摘要与 Trace。 */
  @Get(':runId/steps')
  public async steps(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
  ): Promise<ApiEnvelope<{ items: readonly RagRunStep[] }>> {
    return this.envelope({
      items: await this.runs.listRunSteps(
        toAccessContext(user, this.requestContext),
        parseM06Input(IdSchema, rawRunId),
      ),
    });
  }

  /** 写入取消事实并触发 AbortSignal。 */
  @Post(':runId/cancel')
  public async cancel(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<RagRun>> {
    const body = parseM06Input(CancelRagRunRequestSchema, rawBody);
    const run = await this.runs.cancelRun(
      toAccessContext(user, this.requestContext),
      parseM06Input(IdSchema, rawRunId),
      body.reason,
    );
    this.metrics.m06OperationsTotal.inc({ operation: 'cancel', result: 'success' });
    return this.envelope(run);
  }

  /** 签发 Ticket 并设置 HttpOnly Cookie，避免凭据出现在 URL 与访问日志。 */
  @Post(':runId/stream-ticket')
  public async ticket(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiEnvelope<RunStreamTicket>> {
    const runId = parseM06Input(IdSchema, rawRunId);
    const ticket = await this.runs.issueStreamTicket(
      toAccessContext(user, this.requestContext),
      runId,
    );
    response.setHeader(
      'Set-Cookie',
      `${ticketCookieName}=${encodeURIComponent(ticket.ticket)}; Max-Age=${this.config.run.streamTicketTtlSeconds}; HttpOnly; SameSite=Strict${this.config.appEnv === 'production' ? '; Secure' : ''}; Path=/api/v1/run-streams/${runId}`,
    );
    return this.envelope({ ...ticket, streamUrl: `/api/v1/run-streams/${runId}` });
  }

  /** ETag + sequence 游标轮询降级。 */
  @Get(':runId/events/poll')
  @Header('Cache-Control', 'private, no-cache')
  public async poll(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
    @Query() rawQuery: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiEnvelope<RagRunEventPage> | undefined> {
    const query = parseM06Input(EventPollSchema, rawQuery);
    const page = await this.runs.listEvents(
      toAccessContext(user, this.requestContext),
      parseM06Input(IdSchema, rawRunId),
      query.after,
      query.limit,
    );
    const etag = `"${createHash('sha256')
      .update(`${page.run.id}:${page.nextSequence}:${page.run.status}:${page.streamExpired}`)
      .digest('base64url')}"`;
    response.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    return this.envelope(page);
  }

  /** 已认证 SSE；适合支持认证 Header/Cookie 的客户端。 */
  @Get(':runId/events')
  public async events(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const runId = parseM06Input(IdSchema, rawRunId);
    const initial = parseLastEventId(lastEventId);
    const context = toAccessContext(user, this.requestContext);
    await this.runs.getRun(context, runId);
    await this.streamLoop(request, response, initial, 'authenticated', async (cursor) =>
      this.runs.listEvents(context, runId, cursor, 100),
    );
  }

  private async streamLoop(
    request: Request,
    response: Response,
    initialSequence: number,
    transport: 'authenticated' | 'ticket',
    read: (cursor: number) => Promise<RagRunEventPage>,
  ): Promise<void> {
    prepareSse(response);
    this.metrics.m06SseConnections.inc({ transport });
    let cursor = initialSequence;
    let heartbeatAt = Date.now() + this.config.run.sseHeartbeatSeconds * 1_000;
    try {
      while (!request.destroyed && !response.destroyed) {
        const page = await read(cursor);
        for (const event of page.items) {
          if (!(await writeSse(response, request, event.sequence, event.eventType, event))) return;
          cursor = event.sequence;
        }
        if (page.streamExpired) {
          await writeSse(response, request, cursor, 'stream.expired', {
            run: page.run,
            fallback: `/api/v1/runs/${page.run.id}`,
          });
          break;
        }
        if (terminalStatuses.has(page.run.status) && page.items.length === 0) break;
        if (Date.now() >= heartbeatAt) {
          response.write(`: heartbeat ${Date.now()}\n\n`);
          heartbeatAt = Date.now() + this.config.run.sseHeartbeatSeconds * 1_000;
        }
        await waitForPoll(request, 500);
      }
    } finally {
      this.metrics.m06SseConnections.dec({ transport });
      if (!response.destroyed) response.end();
    }
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

/** 一次性 Ticket SSE；公开路由不代表匿名访问，身份来自 Redis 中的绑定。 */
@Controller('run-streams')
export class RunTicketStreamController {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** Ticket 原子兑换后才写 SSE Header，失败不会建立流。 */
  @Get(':runId')
  @PublicRoute()
  public async stream(
    @Param('runId') rawRunId: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const runId = parseM06Input(IdSchema, rawRunId);
    const rawTicket = readCookie(rawCookie, ticketCookieName);
    const ticket = parseM06Input(TicketSchema, rawTicket);
    const redeemed = await this.runs.redeemStreamTicket(ticket, runId);
    prepareSse(response);
    this.metrics.m06SseConnections.inc({ transport: 'ticket' });
    let cursor = parseLastEventId(lastEventId);
    let heartbeatAt = Date.now() + this.config.run.sseHeartbeatSeconds * 1_000;
    try {
      while (!request.destroyed && !response.destroyed) {
        const [page, currentRun] = await Promise.all([
          this.runs.readTicketEvents(runId, cursor, 100),
          this.runs.getTicketRun(redeemed.userId, runId),
        ]);
        for (const event of page.items) {
          if (!(await writeSse(response, request, event.sequence, event.eventType, event))) return;
          cursor = event.sequence;
        }
        if (!page.exists && terminalStatuses.has(currentRun.status)) {
          await writeSse(response, request, cursor, 'stream.expired', {
            run: currentRun,
            fallback: `/api/v1/runs/${runId}`,
          });
          break;
        }
        if (terminalStatuses.has(currentRun.status) && page.items.length === 0) break;
        if (Date.now() >= heartbeatAt) {
          response.write(`: heartbeat ${Date.now()}\n\n`);
          heartbeatAt = Date.now() + this.config.run.sseHeartbeatSeconds * 1_000;
        }
        await waitForPoll(request, 500);
      }
    } finally {
      this.metrics.m06SseConnections.dec({ transport: 'ticket' });
      if (!response.destroyed) response.end();
    }
  }
}

function parseLastEventId(value: string | undefined): number {
  return value ? parseM06Input(z.coerce.number().int().nonnegative(), value) : 0;
}

function prepareSse(response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'private, no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
}

async function writeSse(
  response: Response,
  request: Request,
  sequence: number,
  eventType: string,
  data: unknown,
): Promise<boolean> {
  if (request.destroyed || response.destroyed) return false;
  const writable = response.write(
    `id: ${sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  if (writable) return true;
  return waitForDrain(response, request, 30_000);
}

async function waitForDrain(
  response: Response,
  request: Request,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      response.off('drain', onDrain);
      request.off('close', onClose);
      resolve(value);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    response.once('drain', onDrain);
    request.once('close', onClose);
  });
}

async function waitForPoll(request: Request, timeoutMs: number): Promise<void> {
  if (request.destroyed) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      request.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    request.once('close', finish);
  });
}
