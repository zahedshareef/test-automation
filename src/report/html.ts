import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { RunSummary, TestResultSummary } from '../core/types.ts';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

const isFailure = (r: TestResultSummary) => r.outcome === 'failed' || r.outcome === 'timedOut' || r.outcome === 'interrupted';

export function verdict(run: RunSummary): { label: string; cls: string } {
  if (run.status !== 'completed') return { label: run.status === 'cancelled' ? 'CANCELLED' : 'RUN ERROR', cls: 'fail' };
  if (run.totals.total === 0) return { label: 'NO TESTS RUN', cls: 'warn' };
  if (run.totals.failed > 0) return { label: 'FAILED', cls: 'fail' };
  if (run.totals.flaky > 0 || run.uncoveredIssues.length > 0) return { label: 'PASSED WITH WARNINGS', cls: 'warn' };
  return { label: 'PASSED', cls: 'pass' };
}

const badge = (o: string) => `<span class="b ${esc(o)}">${esc(o)}</span>`;

/** Writes a self-contained, printable report.html into the run folder. */
export function writeHtmlReport(run: RunSummary, runDir: string): string {
  const rel = (p: string) => path.relative(runDir, p).split(path.sep).join('/');
  const v = verdict(run);
  const scope = run.scope;
  const failures = run.results.filter(isFailure);
  const flaky = run.results.filter((r) => r.outcome === 'flaky');
  const t = run.totals;
  const pct = (n: number) => (t.total ? (n / t.total) * 100 : 0);

  const traceability = (scope?.issues ?? [])
    .map((issue) => {
      const tests = run.results.filter((r) => r.issueKeys.includes(issue.key));
      const status = tests.length === 0 ? 'not covered' : tests.some(isFailure) ? 'failed' : tests.some((x) => x.outcome === 'flaky') ? 'flaky' : tests.every((x) => x.outcome === 'skipped') ? 'skipped' : 'passed';
      return `<tr><td>${issue.url ? `<a href="${esc(issue.url)}">${esc(issue.key)}</a>` : esc(issue.key)}</td><td>${esc(issue.summary)}</td><td>${esc(issue.status)}</td>
        <td>${tests.length ? tests.map((x) => `${badge(x.outcome)} ${esc(x.title)}`).join('<br>') : '<em>No automated tests linked</em>'}</td><td>${badge(status.replace(' ', '-'))}</td></tr>`;
    })
    .join('');

  const failureBlocks = failures
    .map((r) => {
      const shots = r.attachments.filter((a) => a.contentType.startsWith('image/'));
      const trace = r.attachments.find((a) => a.name === 'trace');
      return `<section class="failure">
        <h3>${badge(r.outcome)} ${esc(r.titlePath.join(' › '))}</h3>
        <p class="meta">${esc(r.file)}:${r.line} · ${esc(r.tags.join(' '))} ${r.issueKeys.length ? '· ' + esc(r.issueKeys.join(', ')) : ''} · ${fmtMs(r.durationMs)} · ${r.retries} retr${r.retries === 1 ? 'y' : 'ies'}</p>
        ${r.aiAnalysis ? `<div class="ai"><strong>Copilot triage:</strong> ${esc(r.aiAnalysis)}</div>` : ''}
        <pre class="err">${esc(r.error ?? 'No error message')}</pre>
        ${r.steps.length ? `<details><summary>Steps (${r.steps.length})</summary><pre>${esc(r.steps.join('\n'))}</pre></details>` : ''}
        ${shots.map((s) => `<img src="${esc(rel(s.path))}" alt="Screenshot at failure">`).join('')}
        ${trace ? `<p class="meta">Trace: <code>${esc(rel(trace.path))}</code>. Open it with <code>npx playwright show-trace</code> or trace.playwright.dev.</p>` : ''}
      </section>`;
    })
    .join('');

  const metrics = run.results.flatMap((r) => r.metrics.map((m) => ({ test: r.title, m })));
  const readyTimes = metrics
    .map(({ m }) => /^ready:(.*)=(\d+)ms$/.exec(m))
    .filter((x): x is RegExpExecArray => Boolean(x))
    .map((x) => ({ page: x[1], ms: Number(x[2]) }));
  const byPage = new Map<string, number[]>();
  for (const r of readyTimes) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r.ms]);
  const perfRows = [...byPage.entries()]
    .map(([page, arr]) => ({ page, max: Math.max(...arr), avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length), n: arr.length }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 15)
    .map((p) => `<tr><td><code>${esc(p.page)}</code></td><td class="num">${p.n}</td><td class="num">${fmtMs(p.avg)}</td><td class="num ${p.max > 10_000 ? 'slow' : ''}">${fmtMs(p.max)}</td></tr>`)
    .join('');

  const byFile = new Map<string, TestResultSummary[]>();
  for (const r of run.results) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const allRows = [...byFile.entries()]
    .map(
      ([file, rs]) =>
        `<tr class="grp"><td colspan="4">${esc(file)}</td></tr>` +
        rs.map((r) => `<tr><td>${esc(r.titlePath.join(' › '))}</td><td>${esc([...r.tags, ...r.issueKeys].join(' '))}</td><td class="num">${fmtMs(r.durationMs)}</td><td>${badge(r.outcome)}</td></tr>`).join(''),
    )
    .join('');

  const selectionRows = run.selected
    .map((s) => `<tr><td>${esc(s.titlePath.join(' › '))}</td><td>${esc(s.reasons.join('; '))}</td></tr>`)
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test report ${esc(run.environment)} ${esc(run.createdAt.slice(0, 10))}</title>
<style>
:root{--fg:#1d2433;--muted:#5d6678;--line:#e3e6ec;--bg:#fff;--soft:#f6f7f9;--pass:#18794e;--pass-bg:#e6f4ec;--fail:#c4321a;--fail-bg:#fdecea;--warn:#9a6700;--warn-bg:#fff4d6;--info:#2557a7;--info-bg:#e8f0fb}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:1100px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:14px;margin:0 0 4px}
.meta{color:var(--muted);font-size:12.5px;margin:2px 0 8px}
.verdict{display:inline-block;padding:6px 14px;border-radius:6px;font-weight:700;letter-spacing:.04em;margin:12px 0}
.verdict.pass{background:var(--pass-bg);color:var(--pass)}.verdict.fail{background:var(--fail-bg);color:var(--fail)}.verdict.warn{background:var(--warn-bg);color:var(--warn)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 14px}.tile .n{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}.tile .l{color:var(--muted);font-size:12px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--soft)}.bar span{display:block}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--soft);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.slow{color:var(--fail);font-weight:600}tr.grp td{background:var(--soft);font-weight:600;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.b{display:inline-block;padding:0 7px;border-radius:10px;font-size:11.5px;font-weight:600;white-space:nowrap}
.b.passed{background:var(--pass-bg);color:var(--pass)}.b.failed,.b.timedOut,.b.interrupted,.b.not-covered{background:var(--fail-bg);color:var(--fail)}.b.flaky{background:var(--warn-bg);color:var(--warn)}.b.skipped{background:var(--soft);color:var(--muted)}
.summary{background:var(--info-bg);border-radius:8px;padding:12px 16px;white-space:pre-wrap}
.failure{border:1px solid var(--line);border-left:4px solid var(--fail);border-radius:6px;padding:14px 16px;margin:14px 0;break-inside:avoid}
.ai{background:var(--info-bg);border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px}
pre{background:var(--soft);padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}pre.err{color:var(--fail)}
img{max-width:100%;border:1px solid var(--line);border-radius:4px;margin-top:8px}
ul.notes{margin:8px 0;padding-left:20px;color:var(--muted)}
a{color:var(--info)}
@media print{main{padding:0}h2{break-after:avoid}details{display:block}details>summary{display:none}a{color:inherit;text-decoration:none}}
</style></head><body><main>
<h1>Automated test report</h1>
<p class="meta">Run ${esc(run.id)} · generated ${esc(new Date().toLocaleString())}</p>
<div class="verdict ${v.cls}">${v.label}</div>
<dl class="kv">
<dt>Environment</dt><dd>${esc(run.environment)} · <a href="${esc(run.baseUrl)}">${esc(run.baseUrl)}</a></dd>
<dt>Started</dt><dd>${esc(new Date(run.createdAt).toLocaleString())}${run.finishedAt ? ` · duration ${fmtMs(new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime())}` : ''}</dd>
${scope?.release ? `<dt>Octopus release</dt><dd>${esc(scope.release.projectName)} ${esc(scope.release.version)}${scope.release.environment ? ` (deployed to ${esc(scope.release.environment)})` : ''}</dd>` : ''}
${scope?.issues.length ? `<dt>Jira issues</dt><dd>${scope.issues.map((i) => esc(i.key)).join(', ')}</dd>` : ''}
${scope?.input.jql ? `<dt>JQL</dt><dd><code>${esc(scope.input.jql)}</code></dd>` : ''}
${scope?.tags.length ? `<dt>Tags</dt><dd>${esc(scope.tags.join(' '))}</dd>` : ''}
${scope?.input.freeText ? `<dt>Described scope</dt><dd>${esc(scope.input.freeText)}</dd>` : ''}
</dl>
${run.error ? `<pre class="err">${esc(run.error)}</pre>` : ''}

<div class="tiles">
<div class="tile"><div class="n">${t.total}</div><div class="l">Tests</div></div>
<div class="tile"><div class="n" style="color:var(--pass)">${t.passed}</div><div class="l">Passed</div></div>
<div class="tile"><div class="n" style="color:var(--fail)">${t.failed}</div><div class="l">Failed</div></div>
<div class="tile"><div class="n" style="color:var(--warn)">${t.flaky}</div><div class="l">Flaky (passed on retry)</div></div>
<div class="tile"><div class="n">${t.skipped}</div><div class="l">Skipped</div></div>
<div class="tile"><div class="n">${t.total ? Math.round((t.passed / Math.max(1, t.total - t.skipped)) * 100) : 0}%</div><div class="l">Pass rate</div></div>
</div>
<div class="bar"><span style="width:${pct(t.passed)}%;background:var(--pass)"></span><span style="width:${pct(t.flaky)}%;background:#d4a72c"></span><span style="width:${pct(t.failed)}%;background:var(--fail)"></span><span style="width:${pct(t.skipped)}%;background:#c5cad3"></span></div>

${run.aiSummary ? `<h2>Executive summary</h2><div class="summary">${esc(run.aiSummary)}</div><p class="meta">Written by GitHub Copilot from the results below. Check it against the details.</p>` : ''}

${scope?.issues.length ? `<h2>Requirement traceability</h2><table><thead><tr><th>Issue</th><th>Summary</th><th>Jira status</th><th>Tests</th><th>Result</th></tr></thead><tbody>${traceability}</tbody></table>` : ''}
${run.uncoveredIssues.length ? `<p class="meta"><strong>${run.uncoveredIssues.length} issue(s) have no automated tests:</strong> ${esc(run.uncoveredIssues.join(', '))}. Draft tests for them from the Drafts tab.</p>` : ''}

<h2>Failures (${failures.length})</h2>
${failureBlocks || '<p>No failures.</p>'}

${flaky.length ? `<h2>Flaky tests (${flaky.length})</h2><p class="meta">These failed first and passed on retry. Investigate them before trusting future runs.</p><table><tbody>${flaky.map((r) => `<tr><td>${esc(r.titlePath.join(' › '))}</td><td>${esc(r.file)}:${r.line}</td><td class="num">${r.retries} retries</td></tr>`).join('')}</tbody></table>` : ''}

${perfRows ? `<h2>Page readiness (Blazor boot and render)</h2><table><thead><tr><th>Page</th><th class="num">Samples</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead><tbody>${perfRows}</tbody></table>` : ''}

<h2>All tests</h2>
<table><thead><tr><th>Test</th><th>Tags / issues</th><th class="num">Duration</th><th>Result</th></tr></thead><tbody>${allRows || '<tr><td colspan="4">No results</td></tr>'}</tbody></table>

<h2>Why these tests were selected</h2>
<table><thead><tr><th>Test</th><th>Reason</th></tr></thead><tbody>${selectionRows}</tbody></table>
${scope?.notes.length ? `<ul class="notes">${scope.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}

<h2>Artifacts</h2>
<ul>
<li><a href="playwright-report/index.html">Playwright HTML report</a>, with traces, videos and step-by-step detail</li>
<li><a href="junit.xml">JUnit XML</a></li>
<li><a href="results.json">Raw results (JSON)</a></li>
</ul>
</main></body></html>`;
  const file = path.join(runDir, 'report.html');
  fs.writeFileSync(file, html);
  return file;
}

export async function writePdfReport(htmlFile: string): Promise<string> {
  const pdf = htmlFile.replace(/\.html$/, '.pdf');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlFile.split(path.sep).join('/')}`);
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally {
    await browser.close();
  }
  return pdf;
}
