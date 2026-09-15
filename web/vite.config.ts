import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is a plain client-side app served by Vite.
 *
 * Next.js was considered and rejected: this app has no SSR, no routing and no
 * SEO requirement — it is one page reading a local API — so a framework whose
 * value is exactly those things would be added weight with nothing bought.
 *
 * The dev server proxies /api to the indexer API so the browser makes
 * same-origin requests and no CORS configuration is needed at all.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
