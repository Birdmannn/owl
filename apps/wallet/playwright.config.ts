import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:5176",
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:5176",
      reuseExistingServer: true,
    },
    {
      command: "npm run dev -- --port 5177",
      url: "http://localhost:5177/tests/app.html",
      reuseExistingServer: true,
    },
  ],
});
