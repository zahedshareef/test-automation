import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { waitForBlazor } from './support/blazor';

/**
 * Signs in once through Duende IdentityServer with the test account and saves:
 *  - user.json:    cookies + localStorage (Playwright storageState), including the IdP session cookie
 *  - session.json: sessionStorage of the app origin. Blazor WASM's OIDC library keeps tokens
 *                  there, and Playwright's storageState does not save sessionStorage.
 * The fixtures in support/fixtures.ts restore both for every test.
 */
const authDir = process.env.QA_AUTH_DIR ?? '.auth';
const userFile = path.join(authDir, 'user.json');
const sessionFile = path.join(authDir, 'session.json');
const MAX_AGE_MS = Number(process.env.QA_AUTH_MAX_AGE_MS ?? 20 * 60_000);

setup('sign in through Duende IdentityServer', async ({ page, baseURL }) => {
  const fresh = fs.existsSync(userFile) && fs.existsSync(sessionFile) && Date.now() - fs.statSync(userFile).mtimeMs < MAX_AGE_MS;
  if (fresh && process.env.QA_FORCE_LOGIN !== 'true') {
    setup.info().annotations.push({ type: 'auth', description: 'Reused a sign-in from the last 20 minutes' });
    return;
  }

  const username = process.env.QA_TEST_USER;
  const password = process.env.QA_TEST_USER_PASSWORD;
  if (!username || !password) throw new Error('Test account is not configured: set the username and password in the tool Settings.');

  const appOrigin = new URL(baseURL!).origin;
  // The standard Blazor WASM route that starts the OIDC redirect to the IdP.
  await page.goto(process.env.QA_LOGIN_PATH ?? 'authentication/login');

  const user = process.env.QA_LOGIN_USERNAME_SELECTOR
    ? page.locator(process.env.QA_LOGIN_USERNAME_SELECTOR)
    : page.getByLabel(/user ?name|e-?mail|login|account/i).first();
  const pass = process.env.QA_LOGIN_PASSWORD_SELECTOR
    ? page.locator(process.env.QA_LOGIN_PASSWORD_SELECTOR)
    : page.getByLabel(/password/i).first();
  const submit = process.env.QA_LOGIN_SUBMIT_SELECTOR
    ? page.locator(process.env.QA_LOGIN_SUBMIT_SELECTOR)
    : page.getByRole('button', { name: /log ?in|sign ?in|continue/i }).first();

  await expect(user, 'Duende login page did not show a username field').toBeVisible({ timeout: 30_000 });
  await user.fill(username);
  await pass.fill(password);
  await submit.click();

  // Back on the app, after the /authentication/login-callback route has finished.
  await page.waitForURL((u) => u.origin === appOrigin && !u.pathname.includes('/authentication/'), { timeout: 45_000 }).catch(async () => {
    const msg = await page.locator('.validation-summary-errors, .alert-danger, .danger').first().textContent().catch(() => null);
    throw new Error(`Sign-in did not return to the app${msg ? `: ${msg.trim()}` : ''}. Current URL: ${page.url()}`);
  });
  await waitForBlazor(page);

  fs.mkdirSync(authDir, { recursive: true });
  await page.context().storageState({ path: userFile });
  const session = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
  fs.writeFileSync(sessionFile, JSON.stringify({ origin: appOrigin, values: JSON.parse(session) }));
});
