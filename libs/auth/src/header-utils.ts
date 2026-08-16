/** 读取唯一 Header 值；重复同名 Header 会被拒绝，避免代理和应用解析不一致。 */
import { AuthenticationError } from './authentication.error';

export function readSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  headerName: string,
): string;
export function readSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  headerName: string,
  required: false,
): string | undefined;
export function readSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  headerName: string,
  required = true,
): string | undefined {
  const value = headers[headerName.toLowerCase()];
  if (Array.isArray(value)) throw new AuthenticationError('AUTH_INVALID', '认证信息无效');
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new AuthenticationError('AUTH_REQUIRED', '缺少认证信息');
  return undefined;
}
