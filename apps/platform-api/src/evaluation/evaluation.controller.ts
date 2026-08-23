/**
 * 评测集、异步运行、失败样本与基线的 HTTP Adapter。
 *
 * Controller 只执行 Zod 映射、调用 EvaluationService 和构造统一 Envelope；权限由可信
 * UserContext 与应用服务共同判断。它不执行评分、不轮询模型，也不接受任意 SQL/过滤表达式。
 *
 * @requirement OPS-001
 * @requirement OPS-003
 * @requirement OPS-004
 * @requirement WEB-023
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { EvaluationService } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  CreateEvaluationDatasetRequestSchema,
  CreateEvaluationRunRequestSchema,
  PromoteEvaluationBaselineRequestSchema,
  type ApiEnvelope,
  type EvaluationBaseline,
  type EvaluationCase,
  type EvaluationDataset,
  type EvaluationRun,
  type EvaluationRunDetail,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import { z } from 'zod';
import { toAccessContext } from '../document-ingestion/ingestion-http-utils';
import { envelope, parseInput } from '../identity-access/http-utils';

const IdSchema = z.uuid();

/** 版本化评测集入口。 */
@Controller('evaluation/datasets')
export class EvaluationDatasetsController {
  public constructor(
    @Inject(EvaluationService) private readonly evaluations: EvaluationService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 创建包含 Case 的完整 DRAFT 版本。 */
  @Post()
  public async create(
    @CurrentUser() user: UserContext,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<EvaluationDataset>> {
    const request = parseInput(CreateEvaluationDatasetRequestSchema, rawBody);
    return envelope(
      this.requestContext,
      await this.evaluations.createDataset(toAccessContext(user, this.requestContext), request),
    );
  }

  /** 最近数据集列表。 */
  @Get()
  public async list(
    @CurrentUser() user: UserContext,
  ): Promise<ApiEnvelope<{ items: readonly EvaluationDataset[] }>> {
    return envelope(this.requestContext, {
      items: await this.evaluations.listDatasets(toAccessContext(user, this.requestContext)),
    });
  }

  /** 数据集详情与稳定顺序 Case。 */
  @Get(':datasetId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('datasetId') rawDatasetId: string,
  ): Promise<ApiEnvelope<{ dataset: EvaluationDataset; cases: readonly EvaluationCase[] }>> {
    return envelope(
      this.requestContext,
      await this.evaluations.getDataset(
        toAccessContext(user, this.requestContext),
        parseInput(IdSchema, rawDatasetId),
      ),
    );
  }

  /** 激活版本并原子归档同名旧版本。 */
  @Post(':datasetId/activate')
  public async activate(
    @CurrentUser() user: UserContext,
    @Param('datasetId') rawDatasetId: string,
  ): Promise<ApiEnvelope<EvaluationDataset>> {
    return envelope(
      this.requestContext,
      await this.evaluations.activateDataset(
        toAccessContext(user, this.requestContext),
        parseInput(IdSchema, rawDatasetId),
      ),
    );
  }
}

/** 评测运行与基线入口。 */
@Controller('evaluation/runs')
export class EvaluationRunsController {
  public constructor(
    @Inject(EvaluationService) private readonly evaluations: EvaluationService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 创建异步运行；返回后由 query worker 执行真实 RagRun。 */
  @Post()
  public async create(
    @CurrentUser() user: UserContext,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<EvaluationRun>> {
    return envelope(
      this.requestContext,
      await this.evaluations.createRun(
        toAccessContext(user, this.requestContext),
        parseInput(CreateEvaluationRunRequestSchema, rawBody),
      ),
    );
  }

  /** 最近运行列表。 */
  @Get()
  public async list(
    @CurrentUser() user: UserContext,
  ): Promise<ApiEnvelope<{ items: readonly EvaluationRun[] }>> {
    return envelope(this.requestContext, {
      items: await this.evaluations.listRuns(toAccessContext(user, this.requestContext)),
    });
  }

  /** 指标、基线差异和失败样本。 */
  @Get(':runId')
  public async get(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
  ): Promise<ApiEnvelope<EvaluationRunDetail>> {
    return envelope(
      this.requestContext,
      await this.evaluations.getRun(
        toAccessContext(user, this.requestContext),
        parseInput(IdSchema, rawRunId),
      ),
    );
  }

  /** 把全部门禁通过的运行提升为不可变基线。 */
  @Post(':runId/baselines')
  public async promote(
    @CurrentUser() user: UserContext,
    @Param('runId') rawRunId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<EvaluationBaseline>> {
    return envelope(
      this.requestContext,
      await this.evaluations.promoteBaseline(
        toAccessContext(user, this.requestContext),
        parseInput(IdSchema, rawRunId),
        parseInput(PromoteEvaluationBaselineRequestSchema, rawBody),
      ),
    );
  }
}
