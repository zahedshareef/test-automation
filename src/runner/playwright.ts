import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../core/secrets.ts';
import type { CatalogTest, TestOutcome, TestResultSummary } from '../core/types.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const TESTS_DIR = path.join(ROOT, 'tests');
const PW_CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

const withAt = (t: string) => (t.startsWith('@') ? t : `@${t}`);

function issueKeysOf(annotations: { type: string; description?: string }[] = []): string[] {
  return annotations
    .filter((a) => a.type === 'issue' && a.description)
    .flatMap((a) => a.description!.split(/[\s,]+/))
    .filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
}

interface PwSuite {
  title: string;
  file: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwSpec {
  id: string;
  title: string;
  file: string;
  line: number;
  tags: string[];
  tests: PwTest[];
}
interface PwTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  annotations: { type: string; description?: string }[];
  results: PwResult[];
}
interface PwResult {
  status: string;
  duration: number;
  retry: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string }[];
  attachments?: { name: string; path?: string; contentType: string }[];
  steps?: { title: string; duration: number; error?: unknown; steps?: unknown[] }[];
}

/** Walks the Playwright JSON report tree, yielding each spec with its describe-block title path. */
function* walk(suites: PwSuite[], parents: string[] = []): Generator<{ spec: PwSpec; titlePath: string[] }> {
  for (const s of suites) {
    // The top-level suite title is the file name, which is not part of the title path.
    const here = s.title && s.title !== s.file ? [...parents, s.title] : parents;
    for (const spec of s.specs ?? []) yield { spec, titlePath: [...here, spec.title] };
    yield* walk(s.suites ?? [], here);
  }
}

function runPw(args: string[], env: Record<string, string>, onLine?: (l: string) => void): { child: ChildProcess; done: Promise<{ code: number; stdout: string }> } {
  const child = spawn(process.execPath, [PW_CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    windowsHide: true,
  });
  let stdout = '';
  let buf = '';
  const onData = (d: Buffer, isOut: boolean) => {
    const s = d.toString();
    if (isOut) stdout += s;
    if (!onLine) return;
    buf += s;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) onLine(redact(l));
  };
  child.stdout!.on('data', (d) => onData(d, true));
  child.stderr!.on('data', (d) => onData(d, false));
  const done = new Promise<{ code: number; stdout: string }>((resolve) => {
    child.on('close', (code) => {
      if (buf && onLine) onLine(redact(buf));
      resolve({ code: code ?? 1, stdout });
    });
    child.on('error', (e) => resolve({ code: 1, stdout: String(e) }));
  });
  return { child, done };
}

/** Discovers all runnable tests (excluding the sign-in setup and drafts). */
export async function listTests(env: Record<string, string> = {}): Promise<CatalogTest[]> {
  const { done } = runPw(['test', '--list', '--reporter=json'], { QA_AUTH_MODE: 'none', ...env, QA_RUN_DIR: '' });
  const { stdout, code } = await done;
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`Could not list tests (exit ${code}): ${stdout.slice(0, 1000)}`);
  const report = JSON.parse(stdout.slice(start));
  if (report.errors?.length) throw new Error(`Test files have errors: ${report.errors.map((e: any) => e.message).join('\n')}`);
  const out: CatalogTest[] = [];
  for (const { spec, titlePath } of walk(report.suites)) {
    for (const t of spec.tests) {
      if (t.projectName === 'setup') continue;
      out.push({
        id: spec.id,
        file: spec.file,
        line: spec.line,
        titlePath,
        title: spec.title,
        project: t.projectName,
        tags: spec.tags.map(withAt),
        issueKeys: issueKeysOf(t.annotations),
      });
    }
  }
  return out;
}

/** Lines for Playwright's --test-list file: "[project] › file › describe › title". */
export function testListLines(tests: CatalogTest[], includeSetup: boolean): string[] {
  const lines = tests.map((t) => [`[${t.project}]`, t.file, ...t.titlePath].join(' › '));
  if (includeSetup) lines.unshift('[setup] › auth.setup.ts');
  return lines;
}

export function startRun(opts: {
  runDir: string;
  tests: CatalogTest[];
  env: Record<string, string>;
  includeSetup: boolean;
  onLine: (l: string) => void;
}): { child: ChildProcess; done: Promise<{ code: number }> } {
  const listFile = path.join(opts.runDir, 'test-list.txt');
  fs.writeFileSync(listFile, testListLines(opts.tests, opts.includeSetup).join('\n') + '\n');
  return runPw(['test', '--test-list', listFile], { ...opts.env, QA_RUN_DIR: opts.runDir }, opts.onLine);
}

function flattenSteps(steps: PwResult['steps'] = [], depth = 0): string[] {
  return steps.flatMap((s) => [
    `${'  '.repeat(depth)}${s.error ? '✗' : '✓'} ${s.title} (${s.duration}ms)`,
    ...flattenSteps((s.steps ?? []) as PwResult['steps'], depth + 1),
  ]);
}

/** Converts Playwright's results.json into the tool's result summaries. */
export function parseResults(resultsFile: string): TestResultSummary[] {
  if (!fs.existsSync(resultsFile)) return [];
  const report = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const out: TestResultSummary[] = [];
  for (const { spec, titlePath } of walk(report.suites ?? [])) {
    for (const t of spec.tests) {
      if (t.projectName === 'setup' && t.status === 'expected') continue;
      const last = t.results[t.results.length - 1];
      let outcome: TestOutcome;
      if (t.status === 'flaky') outcome = 'flaky';
      else if (t.status === 'skipped' || last?.status === 'skipped') outcome = 'skipped';
      else if (t.status === 'expected') outcome = 'passed';
      else outcome = (last?.status === 'timedOut' ? 'timedOut' : last?.status === 'interrupted' ? 'interrupted' : 'failed') as TestOutcome;

      const failing = [...t.results].reverse().find((r) => r.status !== 'passed' && r.status !== 'skipped');
      const errorText = failing
        ? (failing.errors?.length ? failing.errors.map((e) => e.message ?? '').join('\n\n') : (failing.error?.message ?? ''))
        : undefined;
      const evidence = failing ?? last;
      out.push({
        id: spec.id,
        title: spec.title,
        titlePath,
        file: spec.file,
        line: spec.line,
        project: t.projectName,
        tags: spec.tags.map(withAt),
        issueKeys: issueKeysOf(t.annotations),
        outcome,
        durationMs: t.results.reduce((a, r) => a + r.duration, 0),
        retries: Math.max(0, t.results.length - 1),
        error: errorText ? redact(stripAnsi(errorText)) : undefined,
        steps: flattenSteps(evidence?.steps),
        attachments: (evidence?.attachments ?? [])
          .filter((a): a is { name: string; path: string; contentType: string } => Boolean(a.path))
          .map((a) => ({ name: a.name, path: a.path, contentType: a.contentType })),
        metrics: t.annotations.filter((a) => a.type === 'metric' && a.description).map((a) => a.description!),
      });
    }
  }
  return out;
}

export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
