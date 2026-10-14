import { defineConfig } from 'vitest/config';

/**
 * 测试配置
 * ========
 *
 * 这里刻意 *不* 引入 @crxjs/vite-plugin，也不引入 Solid：
 * 被测的是纯逻辑（合并算法、快照解析、写回计划），
 * 不需要浏览器环境，所以整个测试套件一秒内就能跑完。
 *
 * `@` 别名必须和 vite.config.ts 保持一致，否则测试里 import 不到源码。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // fork 出来的子进程默认用管道通信，在受限环境里会被拒绝；threads 更快也更稳
    pool: 'threads',
    reporters: ['default'],
  },
});
