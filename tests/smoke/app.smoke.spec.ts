import { test, expect } from '../support/fixtures';
import { blazorErrorVisible } from '../support/blazor';

/**
 * Generic smoke checks that work on any Blazor WASM app without app-specific selectors.
 * They are tagged @smoke, which the tool adds to every run by default.
 */
test.describe('Application smoke', () => {
  test('home page boots the Blazor runtime', { tag: ['@smoke'] }, async ({ app, page }) => {
    const ms = await app.goto('/');
    expect(await blazorErrorVisible(page), 'Blazor error banner is visible').toBe(false);
    expect(ms, 'Blazor took more than 20s to become ready').toBeLessThan(20_000);
    await expect(page).toHaveTitle(/.+/);
  });

  test('signed-in user is not sent back to the login page', { tag: ['@smoke', '@auth'] }, async ({ app, page }) => {
    test.skip(process.env.QA_AUTH_MODE === 'none', 'Environment has no sign-in');
    await app.goto('/');
    expect(page.url()).not.toMatch(/\/authentication\/login|\/Account\/Login/i);
  });

  test('every navigation menu link loads without errors', { tag: ['@smoke', '@navigation'] }, async ({ app, page, baseURL }) => {
    await app.goto('/');
    const origin = new URL(baseURL!).origin;
    const hrefs = await page
      .locator('nav a[href], .nav-link[href], [role=navigation] a[href]')
      .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));
    const internal = [...new Set(hrefs)]
      .filter((h) => h.startsWith(origin) && !/\/authentication\/(logout|login)/i.test(h))
      .slice(0, 30);
    test.info().annotations.push({ type: 'info', description: `Checked ${internal.length} menu links` });

    for (const href of internal) {
      await test.step(`open ${new URL(href).pathname}`, async () => {
        await app.goto(href.slice(origin.length) || '/');
        expect(await blazorErrorVisible(page), `Blazor error banner on ${href}`).toBe(false);
        // The Blazor error banner is always in the DOM (hidden), so check visibility, not text.
        await expect(page.getByText(/Sorry, there's nothing at this address/i)).toHaveCount(0);
      });
    }
  });
});
