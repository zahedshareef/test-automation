import path from 'node:path';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/**
 * The tool sets these variables when it starts a run. Running `npx playwright test`
 * directly also works: set QA_BASE_URL (and QA_TEST_USER / QA_TEST_USER_PASSWORD for sign-in).
 */
const baseURL = process.env.QA_BASE_URL ?? 'http://localhost:5000';
const runDir = process.env.QA_RUN_DIR;
const authMode = process.env.QA_AUTH_MODE ?? 'duende';
const authFile = path.join(process.env.QA_AUTH_DIR ?? '.auth', 'user.json');

const reporter: ReporterDescription[] = runDir
  ? [
      ['list'],
      ['json', { outputFile: path.join(runDir, 'results.json') }],
      ['junit', { outputFile: path.join(runDir, 'junit.xml') }],
      ['html', { outputFolder: path.join(runDir, 'playwright-report'), open: 'never' }],
    ]
  : [['list'], ['html', { open: 'never' }]];

export default defineConfig({
  testDir: './tests',
  // AI drafts are excluded until a tester reviews them and moves them into a suite folder.
  testIgnore: ['**/drafts/**'],
  outputDir: runDir ? path.join(runDir, 'test-results') : 'test-results',
  timeout: Number(process.env.QA_TIMEOUT ?? 60_000),
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: Number(process.env.QA_WORKERS ?? 2),
  retries: Number(process.env.QA_RETRIES ?? 1),
  reporter,
  use: {
    baseURL,
    headless: process.env.QA_HEADED !== 'true',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: process.env.QA_IGNORE_HTTPS_ERRORS === 'true',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testIgnore: ['**/drafts/**', /auth\.setup\.ts/],
      use: { ...devices['Desktop Chrome'], storageState: authMode === 'none' ? undefined : authFile },
      dependencies: authMode === 'none' ? [] : ['setup'],
    },
  ],
});
