import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

/**
 * 构建配置
 * ========
 *
 * - `@` 指向 src 目录（以 / 开头 = 相对项目根目录），
 *   所以源码里可以写 `@/core/merge` 而不是一长串 `../../core/merge`
 * - CRXJS 负责把 manifest 里提到的 HTML / Service Worker 编译到 dist
 * - 生产构建不生成 sourcemap（体积小、也不泄露源码结构）
 */
export default defineConfig(({ mode }) => ({
  plugins: [solid(), crx({ manifest })],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    // CRXJS 的热更新需要固定端口
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development',
    target: 'chrome116',
    cssTarget: 'chrome116',
  },
}));
