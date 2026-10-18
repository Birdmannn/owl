import { fileURLToPath } from 'node:url';

export default {
  base: './',
  resolve: { dedupe: ['@ckb-ccc/core', 'react', 'react-dom'] },
  server: {
    port: 5175, strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../deployments', import.meta.url)), fileURLToPath(new URL('../../src/ckb/delegation-code.ts', import.meta.url)), fileURLToPath(new URL('../../src/ckb/sponsored-code.ts', import.meta.url))],
      deny: ['**/.pilot/**', '**/.git/**', '**/.env', '**/.env.*', '**/*.{crt,pem}'],
    },
  },
};
