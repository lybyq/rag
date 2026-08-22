/**
 * 离线依赖与镜像基线审计入口。
 *
 * 所在链路：外网锁定依赖 -> 本脚本验证 lockfile/平台包/安装脚本/镜像摘要 -> 导出制品 -> 内网复验。
 * 为什么需要：`pnpm-lock.yaml` 只锁版本，不保证 Windows 与 Linux 的可选原生包都已准备，
 * 也不会阻止人员把 Git 仓库、远程 tarball 或未锁 digest 的镜像混入离线包。
 * 本文件只做只读审计，不下载依赖、不执行第三方安装脚本，也不替代内网 SCA 扫描。
 *
 * @requirement CFG-002
 * @requirement CFG-005
 * @requirement CFG-011
 */
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findForbiddenLockfileSources } from '@rag/config';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** 离线清单中一个受控的目标平台。 */
const TargetSchema = z.object({
  os: z.enum(['win32', 'linux']),
  cpu: z.literal('x64'),
  libc: z.enum(['none', 'glibc']),
});

/** 离线清单中一个需要特别审计的原生模块。 */
const NativeModuleSchema = z.object({
  package: z.string().min(1),
  version: z.string().min(1),
  installScript: z.boolean(),
  allowBuild: z.boolean(),
  platformPackages: z.array(z.string().min(1)),
});

/** `config/offline-dependency-manifest.yaml` 的运行时契约。 */
const OfflineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  toolchain: z.object({ node: z.string().min(1), pnpm: z.string().min(1) }),
  targets: z.array(TargetSchema).min(2),
  nativeModules: z.array(NativeModuleSchema),
  imagePolicy: z.object({
    externalFile: z.string().min(1),
    intranetTemplateFile: z.string().min(1),
    requireDigestInStrictMode: z.boolean(),
  }),
  forbiddenSources: z.array(z.string().min(1)),
});

/** package.json 中本脚本需要的最小字段，避免把未经校验的 JSON 当作可信对象。 */
const PackageJsonSchema = z.object({
  name: z.string().min(1),
  packageManager: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** pnpm-workspace 中离线门禁关心的最小字段。 */
const WorkspaceSchema = z.object({
  supportedArchitectures: z.object({
    os: z.array(z.string()),
    cpu: z.array(z.string()),
    libc: z.array(z.string()),
  }),
  allowBuilds: z.record(z.string(), z.boolean()).default({}),
});

/** 一个可聚合输出的审计结果。 */
interface AuditResult {
  /** 必须阻断制品导出的错误。 */
  readonly errors: string[];
  /** 开发阶段可见、严格制品门禁会升级为错误的风险。 */
  readonly warnings: string[];
}

/** 判断依赖版本是否为 registry 上的精确 SemVer，不允许范围、标签和源码地址。 */
function isExactRegistryVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

/** 解析简单的 KEY=VALUE 镜像清单；该格式故意不支持 shell 展开。 */
function parseEnvironmentFile(source: string): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      source
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => {
          const separatorIndex = line.indexOf('=');
          if (separatorIndex <= 0) throw new Error(`无法解析镜像清单行：${line}`);
          return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
        }),
    ),
  );
}

/** 审计 package.json 的依赖来源和根工具链版本。 */
function auditPackageJson(
  packageJson: z.infer<typeof PackageJsonSchema>,
  expectedPnpmVersion: string,
  result: AuditResult,
): void {
  if (
    packageJson.packageManager !== undefined &&
    packageJson.packageManager !== `pnpm@${expectedPnpmVersion}`
  ) {
    result.errors.push(
      `${packageJson.name}: packageManager 必须精确为 pnpm@${expectedPnpmVersion}`,
    );
  }

  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const [name, version] of Object.entries(dependencies)) {
    if (!isExactRegistryVersion(version)) {
      result.errors.push(
        `${packageJson.name}: ${name} 必须使用精确 registry 版本，当前为 ${version}`,
      );
    }
  }
}

/** 验证 lockfile 包含所有目标平台包，且没有绕过 registry 审批的源码或远程 tarball。 */
function auditLockfile(
  lockfile: string,
  manifest: z.infer<typeof OfflineManifestSchema>,
  result: AuditResult,
): void {
  for (const nativeModule of manifest.nativeModules) {
    const moduleCoordinates = `${nativeModule.package}@${nativeModule.version}`;
    if (
      !lockfile.includes(`'${moduleCoordinates}':`) &&
      !lockfile.includes(`  ${moduleCoordinates}:`)
    ) {
      result.errors.push(`lockfile 缺少原生模块 ${nativeModule.package}@${nativeModule.version}`);
    }
    for (const platformPackage of nativeModule.platformPackages) {
      if (
        !lockfile.includes(`'${platformPackage}':`) &&
        !lockfile.includes(`  ${platformPackage}:`)
      ) {
        result.errors.push(`lockfile 缺少目标平台包 ${platformPackage}`);
      }
    }
  }

  const suspiciousLines = findForbiddenLockfileSources(lockfile, manifest.forbiddenSources);
  if (suspiciousLines.length > 0) {
    result.errors.push(`lockfile 含未批准的远程源码/制品来源：${suspiciousLines[0]?.trim()}`);
  }
}

/** 校验 pnpm 对目标架构和依赖安装脚本的显式声明。 */
function auditWorkspace(
  workspace: z.infer<typeof WorkspaceSchema>,
  manifest: z.infer<typeof OfflineManifestSchema>,
  result: AuditResult,
): void {
  for (const required of ['win32', 'linux']) {
    if (!workspace.supportedArchitectures.os.includes(required)) {
      result.errors.push(`pnpm-workspace.yaml 未保留 ${required} 平台依赖`);
    }
  }
  if (!workspace.supportedArchitectures.cpu.includes('x64')) {
    result.errors.push('pnpm-workspace.yaml 未保留 x64 平台依赖');
  }
  if (!workspace.supportedArchitectures.libc.includes('glibc')) {
    result.errors.push('pnpm-workspace.yaml 未保留 Linux glibc 平台依赖');
  }

  for (const nativeModule of manifest.nativeModules.filter((entry) => entry.installScript)) {
    if (workspace.allowBuilds[nativeModule.package] !== nativeModule.allowBuild) {
      result.errors.push(
        `${nativeModule.package} 的 allowBuilds 必须显式为 ${String(nativeModule.allowBuild)}`,
      );
    }
  }
  for (const packageName of Object.keys(workspace.allowBuilds)) {
    if (!manifest.nativeModules.some((entry) => entry.package === packageName)) {
      result.errors.push(`${packageName} 已出现在 allowBuilds，但未登记到离线依赖 Manifest`);
    }
  }
}

/** 校验外网镜像是否锁 digest，并确保内网模板保留不可路由占位符而非误用公网地址。 */
function auditImages(
  externalImages: Readonly<Record<string, string>>,
  intranetTemplateImages: Readonly<Record<string, string>>,
  intranetImages: Readonly<Record<string, string>> | undefined,
  strict: boolean,
  result: AuditResult,
): void {
  for (const [name, imageReference] of Object.entries(externalImages)) {
    if (!imageReference.includes('@sha256:')) {
      const message = `${name} 尚未锁定 sha256 digest：${imageReference}`;
      if (strict) result.errors.push(message);
      else result.warnings.push(message);
    }
  }

  for (const [name, imageReference] of Object.entries(intranetTemplateImages)) {
    if (!imageReference.startsWith('registry.invalid/')) {
      result.errors.push(`${name} 的内网示例必须使用 registry.invalid 防误部署占位符`);
    }
  }

  if (intranetImages === undefined) return;
  const publicRegistries = ['docker.io', 'index.docker.io', 'quay.io', 'ghcr.io', 'gcr.io'];
  for (const [name, imageReference] of Object.entries(intranetImages)) {
    const registry = imageReference.split('/')[0]?.toLocaleLowerCase('en-US') ?? '';
    if (
      imageReference.startsWith('registry.invalid/') ||
      publicRegistries.includes(registry) ||
      (!registry.includes('.') && !registry.includes(':'))
    ) {
      result.errors.push(`${name} 不是明确的企业内网镜像地址：${imageReference}`);
    }
    if (!imageReference.includes('@sha256:')) {
      result.errors.push(`${name} 的内网镜像必须锁定 sha256 digest：${imageReference}`);
    }
  }
}

/** 执行全部只读审计；严格模式用于正式导出内网制品。 */
async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const manifestPath = resolve(repositoryRoot, 'config/offline-dependency-manifest.yaml');
  const manifest = OfflineManifestSchema.parse(parseYaml(await readFile(manifestPath, 'utf8')));
  const rootPackage = PackageJsonSchema.parse(
    JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')),
  );
  const webPackage = PackageJsonSchema.parse(
    JSON.parse(await readFile(resolve(repositoryRoot, 'apps/web-console/package.json'), 'utf8')),
  );
  const workspace = WorkspaceSchema.parse(
    parseYaml(await readFile(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')),
  );
  const lockfile = await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const externalImages = parseEnvironmentFile(
    await readFile(resolve(repositoryRoot, manifest.imagePolicy.externalFile), 'utf8'),
  );
  const intranetTemplateImages = parseEnvironmentFile(
    await readFile(resolve(repositoryRoot, manifest.imagePolicy.intranetTemplateFile), 'utf8'),
  );
  const intranetImagesFile = process.env['INTRANET_IMAGES_FILE'];
  const intranetImages = intranetImagesFile
    ? parseEnvironmentFile(await readFile(resolve(repositoryRoot, intranetImagesFile), 'utf8'))
    : undefined;
  const result: AuditResult = { errors: [], warnings: [] };
  const strict = process.env['OFFLINE_AUDIT_STRICT'] === 'true';

  auditPackageJson(rootPackage, manifest.toolchain.pnpm, result);
  auditPackageJson(webPackage, manifest.toolchain.pnpm, result);
  auditLockfile(lockfile, manifest, result);
  auditWorkspace(workspace, manifest, result);
  auditImages(externalImages, intranetTemplateImages, intranetImages, strict, result);
  if (strict) {
    try {
      await access(resolve(repositoryRoot, '.offline/pnpm-store'));
    } catch {
      result.errors.push('严格离线门禁要求先执行 pnpm offline:prepare 生成 .offline/pnpm-store');
    }
  }

  for (const warning of result.warnings)
    process.stderr.write(`[offline-audit][warning] ${warning}\n`);
  if (result.errors.length > 0) throw new Error(result.errors.join('\n'));
  process.stdout.write(
    `Offline dependency gate passed: ${manifest.nativeModules.length} native baseline(s), strict=${String(strict)}.\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Offline dependency gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
