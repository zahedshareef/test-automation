import { test, expect } from '../support/fixtures';

/**
 * TEMPLATE: copy this file to write a regression test for a feature.
 *
 * How the tool finds tests for a scope:
 *  - Jira scope:     tests with an annotation { type: 'issue', description: 'APP-123' }
 *                    (several issues → several annotations), plus tests whose tags match the
 *                    issue's components/labels via Settings → Jira → component tag map.
 *  - Tag scope:      the tags in `tag: [...]`, e.g. @invoicing @regression.
 *  - Free-text scope: Copilot reads test titles, tags and Jira keys, so give tests descriptive titles.
 *
 * Use app.goto() (not page.goto) so the test waits for Blazor to finish loading.
 */
test.describe('Invoices (template)', () => {
  test(
    'user can export an invoice as PDF',
    {
      tag: ['@regression', '@invoicing'],
      annotation: [{ type: 'issue', description: 'APP-123' }],
    },
    async ({ app, page }) => {
      test.fixme(true, 'Template only: copy and adapt to a real page');

      await app.goto('/invoices');
      await page.getByRole('row', { name: /INV-0001/ }).getByRole('button', { name: 'Export' }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'PDF' }).click();
      expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
    },
  );
});
