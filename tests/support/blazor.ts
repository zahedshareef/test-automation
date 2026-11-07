import type { Page } from '@playwright/test';

/**
 * Waits until the Blazor WebAssembly runtime has booted and replaced the
 * loading placeholder in #app, and any "Authorizing..." step has finished.
 *
 * Set QA_APP_READY_SELECTOR (e.g. "nav", "[data-testid=main-menu]") to wait
 * for an element your app always renders once it is ready.
 */
export async function waitForBlazor(page: Page, timeout = 45_000): Promise<number> {
  const started = Date.now();
  await page.waitForFunction(
    () => {
      const w = window as unknown as { Blazor?: unknown };
      const app = document.querySelector('#app');
      if (!w.Blazor) return false;
      if (!app) return true; // App mounted somewhere else; Blazor is loaded.
      if (app.querySelector('.loading-progress, .loading-progress-text')) return false;
      const text = (app.textContent ?? '').trim();
      if (/^(Authorizing|Checking login state|Loading)\.{0,3}$/i.test(text)) return false;
      return app.childElementCount > 0;
    },
    undefined,
    { timeout, polling: 100 },
  );
  const ready = process.env.QA_APP_READY_SELECTOR;
  if (ready) await page.locator(ready).first().waitFor({ state: 'visible', timeout });
  return Date.now() - started;
}

/** The standard Blazor error banner ("An unhandled error has occurred. Reload"). */
export async function blazorErrorVisible(page: Page): Promise<boolean> {
  return page
    .locator('#blazor-error-ui')
    .isVisible()
    .catch(() => false);
}
