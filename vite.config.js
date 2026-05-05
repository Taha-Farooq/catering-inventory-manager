import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  define: {
    __APP_BUILD__: JSON.stringify(
      process.env.GITHUB_SHA?.slice(0, 7) ||
        process.env.npm_package_version ||
        'dev'
    ),
  },
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/recharts')) return 'recharts';
          if (id.includes('node_modules/xlsx')) return 'xlsx';
          if (id.includes('node_modules/jszip')) return 'jszip';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
