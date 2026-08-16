/** 入库任务、取消、SSE 与 ETag 轮询 HTTP Adapter。 */
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
import { DocumentIngestionService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CancelIngestionJobRequestSchema,
  ListIngestionJobsQuerySchema,
  type ApiEnvelope,
  type CursorPage,
  type IngestionJob,
  type IngestionJobEvent,
  type UserContext,
} from '@rag/contracts';
import { MetricsService, RequestContextService } from '@rag/observability';
import type { Request, Response } from 'express';
import { once } from 'node:events';
import { z } from 'zod';
import { envelope, parseInput } from '../m01/http-utils';
import { toAccessContext } from './m02-http-utils';

const JobIdSchema = z.string().min(1).max(300);
const EventPollQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@Controller('jobs')
export class IngestionJobsController {
  public constructor(
    @Inject(DocumentIngestionService) private readonly ingestion: DocumentIngestionService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get()
  public async list(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<{ items: readonly IngestionJob[]; page: CursorPage }>> {
    const query = parseInput(ListIngestionJobsQuerySchema, rawQuery);
    const result = await this.ingestion.listJobs(toAccessContext(user, this.requestContext), query);
    return envelope(this.requestContext, {
      items: result.items,
      page: { nextCursor: result.nextCursor, hasMore: result.hasMore },
    });
  }

  /** 轮询降级接口通过游标防重复，通过 ETag 避免重复传输。 */
  @Get(':jobId/events/poll')
  @Header('Cache-Control', 'private, no-cache')
  public async pollEvents(
    @CurrentUser() user: UserContext,
    @Param('jobId') rawJobId: string,
    @Query() rawQuery: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiEnvelope<{ items: readonly IngestionJobEvent[]; nextCursor: number }> | undefined> {
    const jobId = parseInput(JobIdSchema, rawJobId);
    const query = parseInput(EventPollQuerySchema, rawQuery);
    const page = await this.ingestion.listJobEvents(
      toAccessContext(user, this.requestContext),
      jobId,
      query.after,
      query.limit,
    );
    response.setHeader('ETag', page.etag);
    if (ifNoneMatch === page.etag) {
      response.status(304);
      return undefined;
    }
    return envelope(this.requestContext, { items: page.items, nextCursor: page.nextCursor });
  }

  /** SSE 支持 Last-Event-ID；客户端断开后立即停止数据库轮询。 */
  @Get(':jobId/events')
  public async streamEvents(
    @CurrentUser() user: UserContext,
    @Param('jobId') rawJobId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const jobId = parseInput(JobIdSchema, rawJobId);
    const initialCursor = lastEventId
      ? parseInput(z.coerce.number().int().nonnegative(), lastEventId)
      : 0;
    const accessContext = toAccessContext(user, this.requestContext);
    await this.ingestion.getJob(accessContext, jobId);

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    let cursor = initialCursor;
    let ticks = 0;
    while (!request.destroyed && !response.destroyed) {
      const page = await this.ingestion.listJobEvents(accessContext, jobId, cursor, 100);
      for (const event of page.items) {
        const writable = response.write(
          `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        if (!writable) await once(response, 'drain');
      }
      cursor = page.nextCursor;
      ticks += 1;
      if (ticks % 15 === 0) response.write(`: heartbeat ${Date.now()}\n\n`);
      await waitForNextPoll(request, 1_000);
    }
    response.end();
  }

  @Get(':jobId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('jobId') rawJobId: string,
  ): Promise<ApiEnvelope<IngestionJob>> {
    const jobId = parseInput(JobIdSchema, rawJobId);
    return envelope(
      this.requestContext,
      await this.ingestion.getJob(toAccessContext(user, this.requestContext), jobId),
    );
  }

  @Post(':jobId/cancel')
  public async cancel(
    @CurrentUser() user: UserContext,
    @Param('jobId') rawJobId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<IngestionJob>> {
    const jobId = parseInput(JobIdSchema, rawJobId);
    const body = parseInput(CancelIngestionJobRequestSchema, rawBody);
    const job = await this.ingestion.cancelJob(
      toAccessContext(user, this.requestContext),
      jobId,
      body.reason,
    );
    this.metrics.m02OperationsTotal.inc({ operation: 'job_cancel', result: 'success' });
    return envelope(this.requestContext, job);
  }
}

/** 等待下一次 DB 事件检查；连接关闭时提前唤醒。 */
async function waitForNextPoll(request: Request, milliseconds: number): Promise<void> {
  if (request.destroyed) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      request.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    request.once('close', finish);
  });
}
