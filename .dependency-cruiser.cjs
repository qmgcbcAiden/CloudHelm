module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'core-is-pure', severity: 'error', from: { path: '^packages/core/' }, to: { path: '^(packages/(application|adapters|contracts)/|apps/)' } },
    { name: 'application-only-core', severity: 'error', from: { path: '^packages/application/' }, to: { path: '^(packages/(adapters|contracts)/|apps/)' } },
    { name: 'adapters-only-core', severity: 'error', from: { path: '^packages/adapters/' }, to: { path: '^(packages/(application|contracts)/|apps/)' } },
    { name: 'renderer-contracts-only', severity: 'error', from: { path: '^apps/desktop/src/(renderer|preload)/' }, to: { path: '^(packages/(core|application|adapters)/|apps/desktop/src/(main|worker)/)' } }
  ],
  options: { tsPreCompilationDeps: true, tsConfig: { fileName: 'tsconfig.json' }, doNotFollow: { path: 'node_modules' } }
};
