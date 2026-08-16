/** 外网开发用的预置身份 Adapter；请求只能选 presetId，不能提交 userId 或 roles。 */
import type {
  AuthPort,
  AuthenticationRequest,
  AuthorizationVersionPort,
  UserContext,
} from '@rag/contracts';
import { AuthenticationError } from './authentication.error';
import { readSingleHeader } from './header-utils';
import { createAuthenticatedContext } from './identity-factory';
import type { RoleMapper } from './role-mapper';

export interface MockIdentityPreset {
  readonly presetId: string;
  readonly label: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface MockAuthConfig {
  readonly appEnv: 'test' | 'development' | 'staging' | 'production';
  readonly defaultPresetId: string;
  readonly selectionHeader: string;
  readonly presets: readonly MockIdentityPreset[];
}

/** 只用于 test/development/staging 的认证实现。 */
export class MockAuthAdapter implements AuthPort {
  private readonly presets: ReadonlyMap<string, MockIdentityPreset>;

  public constructor(
    private readonly config: MockAuthConfig,
    private readonly roleMapper: RoleMapper,
    private readonly versionProvider: AuthorizationVersionPort,
  ) {
    if (config.appEnv === 'production') throw new Error('production 禁止启用 MockAuthAdapter');
    this.presets = new Map(
      config.presets.map((preset) => [preset.presetId, Object.freeze(preset)]),
    );
    if (this.presets.size !== config.presets.length) throw new Error('Mock presetId 不能重复');
    if (!this.presets.has(config.defaultPresetId)) throw new Error('默认 Mock presetId 不存在');
  }

  /** 返回给开发身份切换页的脱敏预置列表。 */
  public listPresets(): readonly MockIdentityPreset[] {
    return [...this.presets.values()];
  }

  public async authenticate(request: AuthenticationRequest): Promise<UserContext> {
    const selectedPresetId =
      readSingleHeader(request.headers, this.config.selectionHeader, false) ??
      this.config.defaultPresetId;
    const preset = this.presets.get(selectedPresetId);
    if (!preset) throw new AuthenticationError('AUTH_INVALID', '开发身份预置不存在');

    return createAuthenticatedContext(
      preset.userId,
      preset.roles,
      this.roleMapper,
      this.versionProvider,
    );
  }
}
