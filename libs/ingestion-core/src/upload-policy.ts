/**
 * 上传元数据净化和会话策略纯函数。
 *
 * @requirement DOC-004
 * @requirement DOC-005
 * @requirement DOC-007
 */

/** 移除路径、控制字符和危险空白，只保留用于展示的短文件名。 */
export function sanitizeOriginalFileName(input: string): string {
  const withoutPath = input.replace(/\\/g, '/').split('/').at(-1) ?? 'unnamed';
  const withoutControls = [...withoutPath]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  const collapsed = withoutControls.replace(/\s+/g, ' ').trim();
  const safe = collapsed.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '');
  return (safe || 'unnamed').slice(0, 240);
}

/** 依据阈值选择直传或 Multipart；等于阈值时仍走单 PUT。 */
export function chooseUploadStrategy(
  sizeBytes: number,
  multipartThresholdBytes: number,
): 'SINGLE' | 'MULTIPART' {
  return sizeBytes > multipartThresholdBytes ? 'MULTIPART' : 'SINGLE';
}

/** S3 Multipart 除最后一片外至少 5 MiB，这里同时接受部署端配置。 */
export function calculatePartCount(sizeBytes: number, configuredPartSizeBytes: number): number {
  const minimumS3PartSize = 5 * 1024 * 1024;
  const partSize = Math.max(minimumS3PartSize, configuredPartSizeBytes);
  return Math.ceil(sizeBytes / partSize);
}

/** 判断 worker lease 是否已经超过安全恢复时间。 */
export function isLeaseExpired(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt !== null && leaseExpiresAt.getTime() <= now.getTime();
}
