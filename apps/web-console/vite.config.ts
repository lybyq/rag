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
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
