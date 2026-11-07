import type { AppConfig } from '../core/config.ts';
import { http } from '../core/http.ts';
import { getSecret, redact } from '../core/secrets.ts';
import type { CatalogTest, JiraIssue, RunSummary, TestResultSummary } from '../core/types.ts';

/**
 * AI provider using an OpenAI-compatible chat completions endpoint authenticated
 * with the configured GitHub token: GitHub Models (models.github.ai), the
 * org-attributed variant, or another Copilot-compatible endpoint your enterprise exposes.
 *
 * Every AI feature is optional. If no token is set, the tool still runs.
 */
export class CopilotAI {
  private cfg: AppConfig['github'];

  constructor(cfg: AppConfig) {
    this.cfg = cfg.github;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.aiEndpoint && getSecret('githubToken'));
  }

  async chat(system: string, user: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
    const token = getSecret('githubToken');
    if (!token) throw new Error('GitHub token is not set, so AI features are disabled.');
    const res = await http<any>(this.cfg.aiEndpoint, {
      method: 'POST',
      timeoutMs: 120_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        model: this.cfg.aiModel,
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 2000,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          // Secrets are redacted from anything sent to the model.
          { role: 'user', content: redact(user) },
        ],
      }),
    });
    return String(res?.choices?.[0]?.message?.content ?? '').trim();
  }

  private async chatJson<T>(system: string, user: string): Promise<T> {
    const text = await this.chat(system, user, { json: true });
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text) as T;
  }

  async ping(): Promise<string> {
    return this.chat('Reply with the single word OK.', 'ping', { maxTokens: 5 });
  }

  /** Free-text scope -> tests from the catalog. */
  async selectTests(freeText: string, catalog: CatalogTest[]): Promise<{ testIds: string[]; tags: string[]; rationale: string }> {
    const list = catalog.map((t) => `${t.id} | ${t.titlePath.join(' > ')} | ${t.tags.join(' ')} | ${t.issueKeys.join(' ')}`).join('\n');
    const out = await this.chatJson<{ testIds?: string[]; tags?: string[]; rationale?: string }>(
      'You are a QA lead choosing regression tests for a web application. Pick only tests that exercise the described change or area, plus close neighbours that could regress. Respond with JSON: {"testIds": string[], "tags": string[], "rationale": string}. Use only ids and tags that appear in the catalog.',
      `Scope described by the tester:\n${freeText}\n\nTest catalog (id | title | tags | Jira keys):\n${list}`,
    );
    const ids = new Set(catalog.map((t) => t.id));
    return {
      testIds: (out.testIds ?? []).filter((id) => ids.has(id)),
      tags: (out.tags ?? []).filter((t) => /^@[\w-]+$/.test(t)),
      rationale: out.rationale ?? '',
    };
  }

  /** Drafts a Playwright test for a Jira issue. Drafts are saved for human review, never run automatically. */
  async draftTest(issue: JiraIssue, context: { exampleTest: string; helpers: string; pageNotes?: string }): Promise<string> {
    const code = await this.chat(
      [
        'You write Playwright tests in TypeScript for a .NET Blazor WebAssembly application that signs in through Duende IdentityServer.',
        'Rules:',
        "- Import { test, expect } from '../support/fixtures' (sign-in and Blazor readiness are handled by fixtures).",
        '- Call await app.goto(path) instead of page.goto so the tool waits for Blazor to finish loading.',
        '- Prefer getByRole, getByLabel and getByText locators. Never use fixed waits such as waitForTimeout.',
        `- Give every test the tag option { tag: ['@regression'], annotation: { type: 'issue', description: '<JIRA KEY>' } }.`,
        '- Write one test per acceptance criterion where possible, named after the criterion.',
        '- Where you must guess a selector or route, add a // TODO(review): comment explaining the guess.',
        'Return only the contents of the .spec.ts file, with no Markdown fences.',
      ].join('\n'),
      [
        `Jira ${issue.key} (${issue.type}): ${issue.summary}`,
        `Description:\n${issue.description || '(none)'}`,
        `Acceptance criteria:\n${issue.acceptanceCriteria || '(none: infer from the description)'}`,
        context.pageNotes ? `Notes about the pages involved:\n${context.pageNotes}` : '',
        `Available fixtures and helpers:\n${context.helpers}`,
        `An existing test in this suite, to match its style:\n${context.exampleTest}`,
      ].join('\n\n'),
      { maxTokens: 4000 },
    );
    return code.replace(/^```(?:ts|typescript)?\s*/i, '').replace(/```\s*$/, '').trim() + '\n';
  }

  async analyseFailure(r: TestResultSummary): Promise<string> {
    return this.chat(
      'You triage failed end-to-end tests of a Blazor WebAssembly app. In at most 5 short sentences: the most likely cause (product bug, test or selector problem, environment or data, or authentication), the evidence for it, and the next step. Be concrete and do not speculate beyond the evidence.',
      `Test: ${r.titlePath.join(' > ')}\nFile: ${r.file}:${r.line}\nRetries: ${r.retries}\nSteps:\n${r.steps.slice(-25).join('\n')}\n\nError:\n${(r.error ?? '').slice(0, 4000)}`,
      { maxTokens: 400 },
    );
  }

  async summariseRun(run: RunSummary): Promise<string> {
    const failures = run.results
      .filter((r) => r.outcome === 'failed' || r.outcome === 'timedOut')
      .map((r) => `- ${r.titlePath.join(' > ')} [${r.issueKeys.join(',')}]: ${(r.error ?? '').split('\n')[0].slice(0, 200)}`)
      .join('\n');
    return this.chat(
      'You write the executive summary of a regression test report for a QA lead and release manager. Use 3 to 6 short bullet points: overall verdict (ready to release or not), what was covered, key failures grouped by likely cause, notable flaky tests, and coverage gaps. Plain text bullets starting with "- ".',
      [
        `Environment: ${run.environment} (${run.baseUrl})`,
        run.scope?.release ? `Octopus release: ${run.scope.release.projectName} ${run.scope.release.version}` : '',
        `Jira issues in scope: ${run.scope?.issues.map((i) => `${i.key} ${i.summary}`).join('; ') || 'none'}`,
        `Issues with no tests: ${run.uncoveredIssues.join(', ') || 'none'}`,
        `Totals: ${JSON.stringify(run.totals)}`,
        `Flaky: ${run.results.filter((r) => r.outcome === 'flaky').map((r) => r.title).join('; ') || 'none'}`,
        `Failures:\n${failures || 'none'}`,
      ].join('\n'),
      { maxTokens: 600 },
    );
  }
}
