import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.spec\.(js|mjs|ts)/,
  outputDir: './artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: './artifacts/test-results.json' }],
    ['html', { outputFolder: './artifacts/html-report', open: 'never' }],
  ],
});
