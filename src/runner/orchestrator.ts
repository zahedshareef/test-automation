import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { CopilotAI } from '../ai/copilot.ts';
import { dataDir, getEnvironment, loadConfig, runsDir } from '../core/config.ts';
import { getSecret, redact } from '../core/secrets.ts';
import type { RunSummary, ScopeInput } from '../core/types.ts';
import { writeHtmlReport, writePdfReport } from '../report/html.ts';
import { publishRun, type PublishOptions } from '../report/publish.ts';
import { resolveScope, selectTests } from '../scope/resolve.ts';
import { listTests, parseResults, startRun } from './playwright.ts';

const MAX_AI_TRIAGE = 10;

/** Runs one test session at a time and keeps the history in the per-user data folder. */
export class RunManager extends EventEmitter {
  private active?: { id: string; child?: ChildProcess; cancelled: boolean };

  runDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid run id');
    return path.join(runsDir(), id);
  }

  private save(run: RunSummary): void {
    fs.writeFileSync(path.join(this.runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
    this.emit('update', run);
  }

  private log(id: string, line: string): void {
    const clean = redact(line);
    fs.appendFileSync(path.join(this.runDir(id), 'run.log'), clean + '\n');
    this.emit('log', id, clean);
  }

  get(id: string): RunSummary | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.runDir(id), 'run.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  readLog(id: string): string {
    try {
      return fs.readFileSync(path.join(this.runDir(id), 'run.log'), 'utf8');
    } catch {
      return '';
    }
  }

  list(): RunSummary[] {
    return fs
      .readdirSync(runsDir())
      .map((d) => this.get(d))
      .filter((r): r is RunSummary => Boolean(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get busy(): boolean {
    return Boolean(this.active);
  }

  /** Resolves the scope and selects tests without running anything. */
  async preview(input: ScopeInput, log: (m: string) => void = () => {}) {
    const cfg = loadConfig();
    const scope = await resolveScope(input, cfg, log);
    const catalog = await listTests();
    const { selected, uncoveredIssues } = await selectTests(scope, catalog, new CopilotAI(cfg), log);
    return { scope, selected, uncoveredIssues, catalogSize: catalog.length };
  }

  /** Starts a run in the background and returns it immediately. */
  start(input: ScopeInput, opts: { headed?: boolean } = {}): RunSummary {
    if (this.active) throw new Error('A run is already in progress. Wait for it to finish or cancel it.');
    const cfg = loadConfig();
    const env = getEnvironment(cfg, input.environment);
    const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}`;
    fs.mkdirSync(this.runDir(id), { recursive: true });
    const run: RunSummary = {
      id,
      createdAt: new Date().toISOString(),
      status: 'pending',
      environment: env.name,
      baseUrl: env.baseUrl,
      selected: [],
      uncoveredIssues: [],
      results: [],
      totals: { passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0, durationMs: 0 },
    };
    this.save(run);
    this.active = { id, cancelled: false };
    void this.execute(run, input, opts).finally(() => {
      this.active = undefined;
      this.emit('idle');
    });
    return run;
  }

  cancel(id: string): boolean {
    if (this.active?.id !== id) return false;
    this.active.cancelled = true;
    this.active.child?.kill();
    return true;
  }

  private async execute(run: RunSummary, input: ScopeInput, opts: { headed?: boolean }): Promise<void> {
    const cfg = loadConfig();
    const env = getEnvironment(cfg, input.environment);
    const dir = this.runDir(run.id);
    const log = (m: string) => this.log(run.id, m);
    const ai = new CopilotAI(cfg);
    try {
      run.status = 'running';
      this.save(run);

      const scope = await resolveScope(input, cfg, log);
      run.scope = scope;
      scope.notes.forEach((n) => log(`• ${n}`));

      log('Discovering tests...');
      const catalog = await listTests();
      const { selected, uncoveredIssues } = await selectTests(scope, catalog, ai, log);
      run.selected = selected;
      run.uncoveredIssues = uncoveredIssues;
      this.save(run);
      log(`Selected ${selected.length} of ${catalog.length} tests.${uncoveredIssues.length ? ` No tests linked to: ${uncoveredIssues.join(', ')}` : ''}`);
      if (selected.length === 0) throw new Error('No tests matched this scope. Add tags, link tests to the Jira issues, or draft tests for them.');

      const authMode = env.authMode;
      if (authMode === 'duende' && (!cfg.testUser.username || !getSecret('testUserPassword'))) {
        throw new Error('This environment signs in through Duende, but the test account username or password is not set in Settings.');
      }
      const authDir = path.join(dataDir(), 'auth', env.name.replace(/[^\w-]/g, '_'));
      const childEnv: Record<string, string> = {
        QA_BASE_URL: env.baseUrl.endsWith('/') ? env.baseUrl : `${env.baseUrl}/`,
        QA_AUTH_MODE: authMode,
        QA_AUTH_DIR: authDir,
        QA_WORKERS: String(cfg.run.workers),
        QA_RETRIES: String(cfg.run.retries),
        QA_TIMEOUT: String(cfg.run.timeoutMs),
        QA_HEADED: String(opts.headed ?? cfg.run.headed),
      };
      if (authMode === 'duende') {
        childEnv.QA_TEST_USER = cfg.testUser.username;
        childEnv.QA_TEST_USER_PASSWORD = getSecret('testUserPassword')!;
      }
      if (cfg.login.usernameSelector) childEnv.QA_LOGIN_USERNAME_SELECTOR = cfg.login.usernameSelector;
      if (cfg.login.passwordSelector) childEnv.QA_LOGIN_PASSWORD_SELECTOR = cfg.login.passwordSelector;
      if (cfg.login.submitSelector) childEnv.QA_LOGIN_SUBMIT_SELECTOR = cfg.login.submitSelector;

      log(`Running against ${env.baseUrl}...`);
      const { child, done } = startRun({ runDir: dir, tests: selected, env: childEnv, includeSetup: authMode === 'duende', onLine: log });
      this.active!.child = child;
      const { code } = await done;
      if (this.active?.cancelled) {
        run.status = 'cancelled';
        log('Run cancelled.');
      }

      run.results = parseResults(path.join(dir, 'results.json'));
      const counted = run.results.filter((r) => r.project !== 'setup' || r.outcome !== 'passed');
      run.totals = {
        passed: counted.filter((r) => r.outcome === 'passed').length,
        failed: counted.filter((r) => ['failed', 'timedOut', 'interrupted'].includes(r.outcome)).length,
        flaky: counted.filter((r) => r.outcome === 'flaky').length,
        skipped: counted.filter((r) => r.outcome === 'skipped').length,
        total: counted.length,
        durationMs: counted.reduce((a, r) => a + r.durationMs, 0),
      };
      if (run.results.length === 0 && code !== 0 && run.status !== 'cancelled') {
        throw new Error(`Playwright exited with code ${code} and produced no results. See the log.`);
      }

      if (ai.enabled && run.status !== 'cancelled') {
        const failures = run.results.filter((r) => ['failed', 'timedOut'].includes(r.outcome)).slice(0, MAX_AI_TRIAGE);
        if (failures.length) log(`Asking Copilot to triage ${failures.length} failure(s)...`);
        for (const r of failures) r.aiAnalysis = await ai.analyseFailure(r).catch((e) => `(triage unavailable: ${e.message})`);
        run.aiSummary = await ai.summariseRun(run).catch((e) => {
          log(`Copilot summary failed: ${e.message}`);
          return undefined;
        });
      }
      if (run.status !== 'cancelled') run.status = 'completed';
    } catch (e) {
      run.status = this.active?.cancelled ? 'cancelled' : 'failed';
      run.error = redact((e as Error).message);
      log(`ERROR: ${run.error}`);
    } finally {
      run.finishedAt = new Date().toISOString();
      try {
        const html = writeHtmlReport(run, dir);
        log('Report written. Creating PDF...');
        await writePdfReport(html);
      } catch (e) {
        log(`Report generation failed: ${(e as Error).message}`);
      }
      this.save(run);
      log(`Done: ${run.status}. ${run.totals.passed} passed, ${run.totals.failed} failed, ${run.totals.flaky} flaky, ${run.totals.skipped} skipped.`);
    }
  }

  async publish(id: string, opts: PublishOptions): Promise<RunSummary> {
    const run = this.get(id);
    if (!run) throw new Error('Run not found');
    const published = await publishRun(run, this.runDir(id), loadConfig(), opts, (m) => this.log(id, m));
    run.published = {
      jiraComments: [...new Set([...(run.published?.jiraComments ?? []), ...published.jiraComments])],
      jiraBugs: [...new Set([...(run.published?.jiraBugs ?? []), ...published.jiraBugs])],
      octopus: published.octopus ?? run.published?.octopus,
    };
    this.save(run);
    return run;
  }
}
