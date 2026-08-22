/**
 * 内网软件成分分析（SCA）报告门禁。
 *
 * 所在链路：内网扫描器扫描离线制品 -> 输出受控 JSON -> 本脚本验证报告和 lockfile 指纹 -> 放行构建。
 * 为什么需要：隔离网通常不能调用公网 `pnpm audit`，但也不能因此取消漏洞门禁。
 * 本脚本只读取扫描结果，不拼接或执行任意命令；具体扫描器可由企业统一选型。
 *
 * @requirement CFG-005
 * @requirement CFG-011
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** 企业扫描器需要归一化输出的最小报告契约。 */
const IntranetScaReportSchema = z.object({
  schemaVersion: z.literal(1),
  scanner: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.literal('pass'),
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  vulnerabilities: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }),
});

/** 计算原始 lockfile 字节的 SHA-256，避免报告复用到另一组依赖。 */
function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 验证报告来自当前 lockfile，且不存在高危或严重漏洞。 */
async function main(): Promise<void> {
  const configuredReportPath = process.env['INTRANET_SCA_REPORT'];
  if (configuredReportPath === undefined || configuredReportPath.trim().length === 0) {
    throw new Error('必须通过 INTRANET_SCA_REPORT 指向内网扫描器生成的 JSON 报告');
  }

  const reportPath = isAbsolute(configuredReportPath)
    ? configuredReportPath
    : resolve(process.cwd(), configuredReportPath);
  const report = IntranetScaReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
  const lockfile = await readFile(resolve(process.cwd(), 'pnpm-lock.yaml'));
  const actualLockfileHash = sha256(lockfile);

  if (report.lockfileSha256 !== actualLockfileHash) {
    throw new Error('SCA 报告的 lockfileSha256 与当前 pnpm-lock.yaml 不一致');
  }
  if (report.vulnerabilities.critical > 0 || report.vulnerabilities.high > 0) {
    throw new Error(
      `SCA 报告未通过：critical=${report.vulnerabilities.critical}, high=${report.vulnerabilities.high}`,
    );
  }

  process.stdout.write(
    `Intranet SCA gate passed: scanner=${report.scanner}, lockfileSha256=${actualLockfileHash}.\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Intranet SCA gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
