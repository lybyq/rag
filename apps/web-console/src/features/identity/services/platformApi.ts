/**
 * Platform API 的唯一浏览器请求入口。
 * Mock 模式只注入服务端预置 ID；业务组件不能自行拼 userId、roles 或可信 Header。
 */
import { ApiErrorSchema } from '@rag/contracts';
import type { z } from 'zod';

const selectedPresetStorageKey = 'rag.dev.identity-preset';

/** 对 UI 暴露稳定错误码，隐藏不可靠的底层网络异常结构。 */
export class PlatformApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

/** 读取当前开发预置 ID；生产认证模式不会使用该值。 */
export function getSelectedDevelopmentPreset(): string | undefined {
  return window.localStorage.getItem(selectedPresetStorageKey) ?? undefined;
}

/** 只持久化 presetId，并限制长度和字符，避免 Header 注入。 */
export function setSelectedDevelopmentPreset(presetId: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(presetId)) throw new Error('开发身份 presetId 非法');
  window.localStorage.setItem(selectedPresetStorageKey, presetId);
}

/** 发送请求并使用给定 Zod Schema 校验服务端响应。 */
export async function platformApiFetch<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.infer<TSchema>> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');

  const selectedPreset = getSelectedDevelopmentPreset();
  if (selectedPreset) headers.set('x-rag-mock-user', selectedPreset);

  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(payload);
    throw new PlatformApiError(
      error.success ? error.data.code : 'NETWORK_ERROR',
      error.success ? error.data.message : `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return schema.parse(payload);
}
