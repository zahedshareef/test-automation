import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfToText, toText } from '../integrations/jira.ts';
import { fingerprint } from '../report/publish.ts';
import { testListLines } from '../runner/playwright.ts';
import { selectTests } from '../scope/resolve.ts';
import type { CatalogTest, ResolvedScope } from './types.ts';

const t = (id: string, over: Partial<CatalogTest> = {}): CatalogTest => ({
  id, file: 'regression/a.spec.ts', line: 1, titlePath: ['Area', id], title: id, project: 'chromium', tags: [], issueKeys: [], ...over,
});
const scope = (over: Partial<ResolvedScope> = {}): ResolvedScope => ({ input: {}, issues: [], tags: [], notes: [], ...over });
const issue = (key: string) => ({ key, summary: '', type: '', status: '', components: [], labels: [], description: '', acceptanceCriteria: '', url: '' });

test('adfToText flattens Atlassian Document Format', () => {
  const adf = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Given a user' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'export works' }] }] }] },
  ] };
  assert.match(adfToText(adf), /Given a user\n.*- export works/s);
  assert.equal(toText('plain'), 'plain');
  assert.equal(toText(null), '');
});

test('selectTests matches by Jira link and tag, and reports uncovered issues', async () => {
  const catalog = [t('a', { issueKeys: ['APP-1'] }), t('b', { tags: ['@smoke'] }), t('c', { tags: ['@other'] })];
  const { selected, uncoveredIssues } = await selectTests(scope({ issues: [issue('APP-1'), issue('APP-2')], tags: ['@smoke'] }), catalog, undefined, () => {});
  assert.deepEqual(selected.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(selected[0].reasons, ['Linked to APP-1']);
  assert.deepEqual(uncoveredIssues, ['APP-2']);
});

test('selectTests falls back to keyword matching without Copilot', async () => {
  const catalog = [t('invoice export works'), t('login page')];
  const s = scope({ input: { freeText: 'check the invoice export' } });
  const { selected } = await selectTests(s, catalog, undefined, () => {});
  assert.deepEqual(selected.map((x) => x.id), ['invoice export works']);
});

test('testListLines produces Playwright --test-list format', () => {
  assert.deepEqual(testListLines([t('x')], true), ['[setup] › auth.setup.ts', '[chromium] › regression/a.spec.ts › Area › x']);
});

test('fingerprint is stable and differs per test', () => {
  assert.equal(fingerprint(t('x')), fingerprint(t('x')));
  assert.notEqual(fingerprint(t('x')), fingerprint(t('y')));
  assert.match(fingerprint(t('x')), /^qa-fp-[0-9a-f]{10}$/);
});
