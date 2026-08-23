/** 当前身份与开发身份预置 API。 */
import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type {
  ApiEnvelope,
  DevelopmentIdentityPreset,
  IdentitySession,
  UserContext,
} from '@rag/contracts';
import { CurrentUser, PublicRoute, ROLE_MAPPER, type RoleMapper } from '@rag/auth';
import { RequestContextService } from '@rag/observability';
import { envelope } from './http-utils';

@Controller('auth')
export class IdentityController {
  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROLE_MAPPER) private readonly roleMapper: RoleMapper,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
  ) {}

  /** 返回服务端已经建立的身份，不回显原始 JWT 或内网角色。 */
  @Get('me')
  public me(@CurrentUser() user: UserContext): ApiEnvelope<IdentitySession> {
    return envelope(this.requestContext, {
      user: {
        userId: user.userId,
        roles: [...user.roles],
        authzVersion: user.authzVersion,
        resolvedAt: user.resolvedAt,
      },
      authMode: this.config.auth.mode,
      appEnv: this.config.appEnv,
    });
  }

  /** 只有非生产 Mock 模式公开预置列表，浏览器只能选择 presetId。 */
  @Get('dev/presets')
  @PublicRoute()
  public developmentPresets(): ApiEnvelope<{
    selectionHeader: string;
    defaultPresetId: string;
    items: readonly DevelopmentIdentityPreset[];
  }> {
    if (this.config.appEnv === 'production' || this.config.auth.mode !== 'mock') {
      throw new NotFoundException();
    }
    return envelope(this.requestContext, {
      selectionHeader: this.config.auth.mock.selectionHeader,
      defaultPresetId: this.config.auth.mock.defaultPresetId,
      items: this.config.auth.mock.presets.map((preset) => ({
        presetId: preset.presetId,
        label: preset.label,
        userId: preset.userId,
        roles: [...this.roleMapper.map(preset.roles)],
      })),
    });
  }
}
