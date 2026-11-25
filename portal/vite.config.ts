import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    host: process.env.DEV_HOST ?? '127.0.0.1',
    allowedHosts: process.env.PASSKEY_ORIGIN ? [new URL(process.env.PASSKEY_ORIGIN).hostname] : [],
    port: 5173,
    watch: { usePolling: process.env.WATCH_POLLING === 'true' },
    fs: {
      deny: ['.env', '.env.*', '**/*.{crt,pem}', '**/.git/**', '**/data/**', '**/server/**', '**/config/**', '**/tests/**', '**/*.{sqlite,sqlite3,db,sqlite-wal,sqlite-shm}'],
    },
    proxy: {
      '/api/portal': `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      '/grocy': process.env.APP_GATEWAY_URL ?? 'http://127.0.0.1:8080',
      '/webtrees': process.env.APP_GATEWAY_URL ?? 'http://127.0.0.1:8080',
    },
  },
});