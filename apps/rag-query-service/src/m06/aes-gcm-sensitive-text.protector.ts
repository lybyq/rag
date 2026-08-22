/**
 * M06 问题、答案与摘要的合规正文保护 Adapter。
 *
 * AES_256_GCM 每次生成独立 96-bit IV，并在读取时验证认证标签与明文 SHA-256。
 * REDACTED 只保留 Hash；PLAIN 仅允许非生产开发，生产配置门禁会拒绝。
 *
 * @requirement RUN-014
 */
import type { ProtectedSensitiveText, SensitiveTextProtectorPort } from '@rag/application';
import type { AppConfig } from '@rag/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Node crypto AES-256-GCM 敏感正文保护器。 */
export class AesGcmSensitiveTextProtector implements SensitiveTextProtectorPort {
  private readonly key: Buffer;

  public constructor(private readonly config: AppConfig['run']) {
    this.key = Buffer.from(config.contentEncryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('RUN_CONTENT_ENCRYPTION_KEY 必须是 32 字节');
  }

  /** 按配置保护 UTF-8 正文；任何模式都保留不可逆 SHA-256 供幂等和审计。 */
  public protect(plaintext: string): ProtectedSensitiveText {
    const sha256 = digest(plaintext);
    if (this.config.contentStorage === 'REDACTED') return this.redacted(sha256);
    if (this.config.contentStorage === 'PLAIN') {
      return { storage: 'PLAIN', value: plaintext, sha256 };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      storage: 'AES_256_GCM',
      value: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      sha256,
    };
  }

  /** 解密失败、认证标签错误或 Hash 不一致均 fail-closed 返回 null。 */
  public reveal(protectedText: ProtectedSensitiveText): string | null {
    if (protectedText.storage === 'REDACTED') return null;
    if (protectedText.storage === 'PLAIN') {
      return digest(protectedText.value) === protectedText.sha256 ? protectedText.value : null;
    }
    if (!protectedText.iv || !protectedText.authTag) return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(protectedText.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(protectedText.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(protectedText.value, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return digest(plaintext) === protectedText.sha256 ? plaintext : null;
    } catch {
      return null;
    }
  }

  /** 创建不含原文的保留期清理/脱敏事实。 */
  public redacted(originalSha256: string): ProtectedSensitiveText {
    return {
      storage: 'REDACTED',
      value: '[内容已按合规策略脱敏]',
      sha256: originalSha256,
    };
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
