import { defineConfig } from 'vite';

// 상대 경로로 빌드해서 GitHub Pages처럼 하위 주소에 올려도 동작하게 한다
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 700 },
  test: { include: ['test/**/*.test.js'] },
});
