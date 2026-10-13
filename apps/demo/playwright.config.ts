import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', timeout: 45_000, use: { baseURL: 'http://127.0.0.1:5174', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }, webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5174', reuseExistingServer: true } });
