/**
 * 对 TypeScript 路径解析后的依赖图执行强制分层检查。
 * 这里显式枚举 App 之间的禁止方向，避免正则无法区分“同 App 内引用”。
 *
 * @requirement BASE-005
 */
const appNames = ['platform-api', 'rag-query-service', 'ingestion-worker', 'scheduler-worker'];

const crossAppRules = appNames.flatMap((fromApp) =>
  appNames
    .filter((toApp) => toApp !== fromApp)
    .map((toApp) => ({
      name: `no-${fromApp}-to-${toApp}`,
      severity: 'error',
      from: { path: `^apps/${fromApp}/` },
      to: { path: `^apps/${toApp}/` },
    })),
);

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'libs-must-not-depend-on-apps',
      severity: 'error',
      from: { path: '^libs/' },
      to: { path: '^apps/' },
    },
    {
      name: 'contracts-are-foundational',
      severity: 'error',
      from: { path: '^libs/contracts/' },
      to: { pathNot: '^libs/contracts/' },
    },
    {
      name: 'domain-only-depends-on-contracts-or-domain',
      severity: 'error',
      from: { path: '^libs/domain/' },
      to: { pathNot: '^libs/(contracts|domain)/' },
    },
    {
      name: 'application-does-not-depend-on-adapters',
      severity: 'error',
      from: { path: '^libs/application/' },
      to: { path: '^libs/(persistence-|model-gateway|auth)' },
    },
    ...crossAppRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: ['(^|/)node_modules/', '(^|/)dist/', '\\.spec\\.ts$'],
    tsConfig: { fileName: 'tsconfig.check.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
