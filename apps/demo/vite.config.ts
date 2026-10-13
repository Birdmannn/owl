import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@owl/pilot-react/styles.css': fileURLToPath(new URL('../../packages/react/src/styles.css', import.meta.url)), '@owl/pilot-react': fileURLToPath(new URL('../../packages/react/src/index.ts', import.meta.url)), '@owl/pilot': fileURLToPath(new URL('../../src/index.ts', import.meta.url)) }, dedupe: ['@ckb-ccc/core', 'react', 'react-dom'] },
  server: { port: 5174, strictPort: true, proxy: { '/api/pilot': { target: process.env.PILOT_REGISTRY_URL || 'http://127.0.0.1:5180', changeOrigin: true } }, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))], deny: ['**/data/**', '**/.pilot/**', '**/.git/**', '**/.env', '**/.env.*', '**/*.{crt,pem}'] } },
});
