import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../support/fixtures';

/**
 * Accessibility scan (WCAG 2.1 A/AA) of key pages. Fails on serious or critical violations.
 * Pages come from QA_A11Y_PATHS (comma-separated), default "/".
 */
const paths = (process.env.QA_A11Y_PATHS ?? '/').split(',').map((p) => p.trim()).filter(Boolean);

for (const p of paths) {
  test(`page ${p} has no serious accessibility violations`, { tag: ['@a11y'] }, async ({ app, page }, testInfo) => {
    await app.goto(p);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    await testInfo.attach('axe-results.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking.map((v) => `${v.impact}: ${v.id} (${v.nodes.length} elements): ${v.help}`)).toEqual([]);
  });
}
