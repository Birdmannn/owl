import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  build: { rollupOptions: { input: { wallet: fileURLToPath(new URL("./index.html", import.meta.url)), auth: fileURLToPath(new URL("./auth.html", import.meta.url)) } } },
  resolve: { dedupe: ["@ckb-ccc/core"] },
  server: {
    port: 5176,
    strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
      deny: [
        "**/.pilot/**",
        "**/.pool/**",
        "**/.git/**",
        "**/.env",
        "**/.env.*",
        "**/data/**",
      ],
    },
  },
});
