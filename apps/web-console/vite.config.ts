import vue from '@vitejs/plugin-vue';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Element Plus 组件和 composable 使用按需自动导入，减少首屏体积。
 * `/api` 代理只服务本地开发，生产路由由网关统一配置。
 */
export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      // Vitest 黑盒组件测试使用 Stub，不加载 Element Plus CSS 副作用；生产构建仍按需注入 CSS。
      resolvers: [ElementPlusResolver({ importStyle: process.env.VITEST ? false : 'css' })],
      dts: 'auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver({ importStyle: process.env.VITEST ? false : 'css' })],
      dts: 'components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@rag/contracts': fileURLToPath(new URL('../../libs/contracts/src', import.meta.url)),
      // Element Plus X 的发布包会从 ESM 入口级联加载 CSS；单测使用行为 Stub，
      // 让测试只验证本项目 Adapter 契约，不把上游样式加载器当作业务行为。
      ...(process.env.VITEST
        ? {
            'vue-element-plus-x': fileURLToPath(
              new URL('./src/test/vue-element-plus-x.stub.ts', import.meta.url),
            ),
          }
        : {}),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 查询面路由必须在通用 platform-api 代理之前声明，否则本地开发会错误转发到 3000。
      '/api/v1/conversations': 'http://localhost:3001',
      '/api/v1/runs': 'http://localhost:3001',
      '/api/v1/run-streams': 'http://localhost:3001',
      '/api/v1/citations': 'http://localhost:3001',
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Playwright 与 Vitest 都使用 *.spec.ts；目录边界防止两个 Runner 互相收集测试。
    exclude: ['e2e/**', 'test-results/**', 'node_modules/**', 'dist/**'],
  },
});
