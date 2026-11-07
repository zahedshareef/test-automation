import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { blazorErrorVisible, waitForBlazor } from './blazor';

export interface App {
  /** Navigates to a path relative to the base URL and waits for Blazor to be ready. Returns the wait time in ms. */
  goto(path: string): Promise<number>;
  waitForReady(): Promise<number>;
  page: Page;
}

interface Fixtures {
  app: App;
  /** Runs for every test: restores the session, collects console errors, fails on the Blazor error banner. */
  blazorGuard: void;
}

const sessionFile = path.join(process.env.QA_AUTH_DIR ?? '.auth', 'session.json');

export const test = base.extend<Fixtures>({
  blazorGuard: [
    async ({ page }, use, testInfo) => {
      // Restore the OIDC tokens Blazor keeps in sessionStorage, before any app script runs.
      if (process.env.QA_AUTH_MODE !== 'none' && fs.existsSync(sessionFile)) {
        const { origin, values } = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        await page.addInitScript(
          ([o, v]) => {
            if (location.origin !== o) return;
            for (const [k, val] of Object.entries(v as Record<string, string>)) {
              if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, val);
            }
          },
          [origin, values] as const,
        );
      }

      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(`Uncaught: ${e.message}`));

      await use();

      if (consoleErrors.length) {
        await testInfo.attach('console-errors.txt', { body: consoleErrors.join('\n'), contentType: 'text/plain' });
      }
      if (testInfo.status === 'passed' && (await blazorErrorVisible(page))) {
        throw new Error(`Blazor error banner (#blazor-error-ui) was visible at the end of the test.\nConsole errors:\n${consoleErrors.join('\n')}`);
      }
    },
    { auto: true },
  ],

  app: async ({ page }, use, testInfo) => {
    await use({
      page,
      async goto(p: string) {
        await page.goto(p.replace(/^\//, ''));
        const ms = await waitForBlazor(page);
        testInfo.annotations.push({ type: 'metric', description: `ready:${p}=${ms}ms` });
        return ms;
      },
      waitForReady: () => waitForBlazor(page),
    });
  },
});

export { expect };
