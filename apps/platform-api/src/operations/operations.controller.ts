/**
 * 总览、运维、Provider、Flag 和审计日志 HTTP Adapter。
 *
 * 查询参数全部通过 Zod 白名单，CSV 由已脱敏 AuditLogEntry 生成；Controller 不读取环境变量，
 * 不连接外部依赖，也不在错误响应中返回内部异常。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement OPS-018
 * @requirement WEB-006
 * @requirement WEB-024
 * @requirement WEB-025
 * @requirement WEB-026
 */
import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { OperationsService, type AuditLogPage } from '@rag/application';
import { CurrentUser } from '@rag/auth';
import {
  AuditLogQuerySchema,
  UpdateFeatureFlagRequestSchema,
  UpdateOperationalAlertRequestSchema,
  type ApiEnvelope,
  type AuditLogEntry,
  type FeatureFlag,
  type OperationalAlert,
  type OperationsDashboard,
  type PlatformOverview,
  type ProviderProfileStatus,
  type UserContext,
} from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import type { Response } from 'express';
import { z } from 'zod';
import { toAccessContext } from '../document-ingestion/ingestion-http-utils';
import { envelope, parseInput } from '../identity-access/http-utils';

const IdSchema = z.uuid();
const FlagKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/);
const FlagScopeQuerySchema = z.object({ spaceId: z.uuid().optional() }).strict();

/** 平台业务总览。 */
@Controller('platform')
export class PlatformOverviewController {
  public constructor(
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get('overview')
  public async overview(@CurrentUser() user: UserContext): Promise<ApiEnvelope<PlatformOverview>> {
    return envelope(
      this.requestContext,
      await this.operations.overview(toAccessContext(user, this.requestContext)),
    );
  }
}

/** 运维控制面。 */
@Controller('operations')
export class OperationsController {
  public constructor(
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  @Get('dashboard')
  public async dashboard(
    @CurrentUser() user: UserContext,
  ): Promise<ApiEnvelope<OperationsDashboard>> {
    return envelope(
      this.requestContext,
      await this.operations.dashboard(toAccessContext(user, this.requestContext)),
    );
  }

  @Get('providers')
  public async providers(
    @CurrentUser() user: UserContext,
  ): Promise<ApiEnvelope<{ items: readonly ProviderProfileStatus[] }>> {
    return envelope(this.requestContext, {
      items: await this.operations.providersStatus(toAccessContext(user, this.requestContext)),
    });
  }

  @Post('alerts/:alertId')
  public async alert(
    @CurrentUser() user: UserContext,
    @Param('alertId') rawAlertId: string,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<OperationalAlert>> {
    return envelope(
      this.requestContext,
      await this.operations.acknowledgeAlert(
        toAccessContext(user, this.requestContext),
        parseInput(IdSchema, rawAlertId),
        parseInput(UpdateOperationalAlertRequestSchema, rawBody),
      ),
    );
  }

  @Get('feature-flags')
  public async flags(
    @CurrentUser() user: UserContext,
  ): Promise<ApiEnvelope<{ items: readonly FeatureFlag[] }>> {
    return envelope(this.requestContext, {
      items: await this.operations.listFeatureFlags(toAccessContext(user, this.requestContext)),
    });
  }

  @Put('feature-flags/:flagKey')
  public async updateFlag(
    @CurrentUser() user: UserContext,
    @Param('flagKey') rawFlagKey: string,
    @Query() rawQuery: Record<string, unknown>,
    @Body() rawBody: unknown,
  ): Promise<ApiEnvelope<FeatureFlag>> {
    const query = parseInput(FlagScopeQuerySchema, rawQuery);
    return envelope(
      this.requestContext,
      await this.operations.updateFeatureFlag(
        toAccessContext(user, this.requestContext),
        parseInput(FlagKeySchema, rawFlagKey),
        query.spaceId ?? null,
        parseInput(UpdateFeatureFlagRequestSchema, rawBody),
      ),
    );
  }

  @Get('audit')
  public async audit(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ApiEnvelope<AuditLogPage>> {
    return envelope(
      this.requestContext,
      await this.operations.auditLogs(
        toAccessContext(user, this.requestContext),
        parseInput(AuditLogQuerySchema, rawQuery),
      ),
    );
  }

  @Get('audit/export')
  public async exportAudit(
    @CurrentUser() user: UserContext,
    @Query() rawQuery: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const rows = await this.operations.exportAudit(
      toAccessContext(user, this.requestContext),
      parseInput(AuditLogQuerySchema, rawQuery),
    );
    response.status(200);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="rag-audit-export.csv"');
    response.end(toCsv(rows));
  }
}

function toCsv(rows: readonly AuditLogEntry[]): string {
  const header = [
    'id',
    'userId',
    'roles',
    'action',
    'resourceType',
    'resourceId',
    'result',
    'reason',
    'occurredAt',
  ];
  const body = rows.map((row) =>
    [
      row.id,
      row.userId,
      row.roles.join('|'),
      row.action,
      row.resourceType,
      row.resourceId ?? '',
      row.result,
      row.reason ?? '',
      row.occurredAt,
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[header.join(','), ...body].join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  // 以公式控制符开头的单元格加单引号，防止 Excel 打开导出文件时执行 CSV Formula Injection。
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
