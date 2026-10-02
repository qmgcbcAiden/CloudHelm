import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const workspacePackages = ['@cloudhelm/contracts', '@cloudhelm/core', '@cloudhelm/application', '@cloudhelm/adapters'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: {
      index: resolve(here, 'src/main/index.ts'),
      runtime: resolve(here, 'src/worker/runtime.ts')
    } } }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve(here, 'src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { root: resolve(here, 'src/renderer'), build: { rollupOptions: { input: resolve(here, 'src/renderer/index.html') } } }
});
