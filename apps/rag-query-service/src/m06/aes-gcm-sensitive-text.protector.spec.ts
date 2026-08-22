/**
 * M06 正文保护器单元门禁。
 * 覆盖 AES-GCM 随机 IV、认证失败 fail-closed、Hash 校验和脱敏模式，防止明文误落库。
 *
 * @requirement RUN-014
 */
import type { AppConfig } from '@rag/config';
import { AesGcmSensitiveTextProtector } from './aes-gcm-sensitive-text.protector';

const key = Buffer.from('m06-integration-key-32-bytes!!!!').toString('base64');

describe('[RUN-014] AesGcmSensitiveTextProtector', () => {
  test('同一正文使用不同 IV 加密并可校验解密', () => {
    const protector = createProtector('AES_256_GCM');
    const first = protector.protect('内网薪酬制度');
    const second = protector.protect('内网薪酬制度');

    expect(first.value).not.toBe('内网薪酬制度');
    expect(first.value).not.toBe(second.value);
    expect(first.sha256).toBe(second.sha256);
    expect(protector.reveal(first)).toBe('内网薪酬制度');
  });

  test('密文、认证标签或 Hash 被篡改时不返回任何正文', () => {
    const protector = createProtector('AES_256_GCM');
    const protectedText = protector.protect('敏感问题');
    const first = protectedText.value.at(0) === 'A' ? 'B' : 'A';

    expect(
      protector.reveal({ ...protectedText, value: `${first}${protectedText.value.slice(1)}` }),
    ).toBeNull();
    expect(protector.reveal({ ...protectedText, sha256: '0'.repeat(64) })).toBeNull();
  });

  test('REDACTED 模式只保存不可逆 Hash', () => {
    const protector = createProtector('REDACTED');
    const protectedText = protector.protect('不应落库的正文');

    expect(protectedText.storage).toBe('REDACTED');
    expect(protectedText.value).not.toContain('不应落库');
    expect(protector.reveal(protectedText)).toBeNull();
  });
});

function createProtector(
  contentStorage: AppConfig['run']['contentStorage'],
): AesGcmSensitiveTextProtector {
  return new AesGcmSensitiveTextProtector({
    contentStorage,
    contentEncryptionKey: key,
  } as AppConfig['run']);
}
