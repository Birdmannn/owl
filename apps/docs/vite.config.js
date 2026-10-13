import { fileURLToPath } from 'node:url';

export default {
  base: './',
  resolve: { dedupe: ['@ckb-ccc/core', 'react', 'react-dom'] },
  server: {
    port: 5175, strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../deployments', import.meta.url))],
      deny: ['**/.pilot/**', '**/.git/**', '**/.env', '**/.env.*', '**/*.{crt,pem}'],
    },
  },
};
