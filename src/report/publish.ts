import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../core/config.ts';
import type { RunSummary, TestResultSummary } from '../core/types.ts';
import { JiraClient } from '../integrations/jira.ts';
import { OctopusClient } from '../integrations/octopus.ts';
import { verdict } from './html.ts';

export interface PublishOptions {
  /** Comment a results summary (and attach the PDF) on each in-scope Jira issue. */
  jiraComments: boolean;
  /** Ids of failed tests to file as Jira bugs, reviewed and chosen by the tester. */
  bugTestIds: string[];
  /** Record results on the Octopus release or deployment. */
  octopus: boolean;
}

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const icon = (o: string) => (o === 'passed' ? '(/)' : o === 'flaky' ? '(!)' : o === 'skipped' ? '(-)' : '(x)');
const wikiEsc = (s: string) => s.replace(/[|{}[\]]/g, (c) => `\\${c}`);

/** A stable id for a failing test, so re-runs update the same bug instead of filing duplicates. */
export function fingerprint(r: Pick<TestResultSummary, 'file' | 'titlePath'>): string {
  return 'qa-fp-' + crypto.createHash('sha1').update(`${r.file}|${r.titlePath.join('>')}`).digest('hex').slice(0, 10);
}

export async function publishRun(run: RunSummary, runDir: string, cfg: AppConfig, opts: PublishOptions, log: (m: string) => void): Promise<NonNullable<RunSummary['published']>> {
  const published: NonNullable<RunSummary['published']> = { jiraComments: [], jiraBugs: [] };
  const pdf = path.join(runDir, 'report.pdf');
  const v = verdict(run);

  if (opts.jiraComments && run.scope?.issues.length) {
    const jira = new JiraClient(cfg);
    for (const issue of run.scope.issues) {
      const tests = run.results.filter((r) => r.issueKeys.includes(issue.key));
      const rows = tests.map((r) => `|${wikiEsc(r.titlePath.join(' › '))}|${icon(r.outcome)} ${r.outcome}|${(r.durationMs / 1000).toFixed(1)}s|`).join('\n');
      const body = [
        `h4. Automated regression: ${v.label}`,
        `*Environment:* ${run.environment} (${run.baseUrl})${run.scope.release ? ` · *Release:* ${run.scope.release.version}` : ''} · *Run:* ${run.id}`,
        `*Overall:* ${run.totals.passed} passed, ${run.totals.failed} failed, ${run.totals.flaky} flaky, ${run.totals.skipped} skipped`,
        tests.length ? `||Test linked to ${issue.key}||Result||Duration||\n${rows}` : `(!) No automated tests are linked to ${issue.key}.`,
        fs.existsSync(pdf) ? `Full report attached: [^${path.basename(pdf)}]` : '',
      ].filter(Boolean).join('\n');
      try {
        if (fs.existsSync(pdf)) await jira.attachFile(issue.key, pdf, `test-report-${run.id}.pdf`);
        await jira.addComment(issue.key, body.replace(`[^${path.basename(pdf)}]`, `[^test-report-${run.id}.pdf]`));
        published.jiraComments.push(issue.key);
        log(`Commented on ${issue.key}`);
      } catch (e) {
        log(`Could not comment on ${issue.key}: ${(e as Error).message}`);
      }
    }
  }

  if (opts.bugTestIds.length) {
    const jira = new JiraClient(cfg);
    for (const r of run.results.filter((x) => opts.bugTestIds.includes(x.id) && x.outcome !== 'passed' && x.outcome !== 'skipped')) {
      const fp = fingerprint(r);
      try {
        const existing = await jira.findOpenBugByFingerprint(fp);
        if (existing) {
          await jira.addComment(existing, `(x) Failed again on ${run.environment} in run ${run.id}${run.scope?.release ? ` (release ${run.scope.release.version})` : ''}.\n{noformat}${(r.error ?? '').slice(0, 3000)}{noformat}`);
          published.jiraBugs.push(existing);
          log(`${existing} is already open for "${r.title}", so a comment was added instead of a new bug`);
          continue;
        }
        const description = [
          `h3. Failure found by automated regression testing`,
          `*Test:* ${wikiEsc(r.titlePath.join(' › '))}`,
          `*Location:* {{${r.file}:${r.line}}}`,
          `*Environment:* ${run.environment} ([${run.baseUrl}])`,
          run.scope?.release ? `*Octopus release:* ${run.scope.release.projectName} ${run.scope.release.version}` : '',
          r.issueKeys.length ? `*Related issues:* ${r.issueKeys.join(', ')}` : '',
          `*Result:* ${r.outcome} after ${r.retries} retr${r.retries === 1 ? 'y' : 'ies'}`,
          r.aiAnalysis ? `h4. Triage (GitHub Copilot, unverified)\n${r.aiAnalysis}` : '',
          `h4. Error\n{noformat}${(r.error ?? '').slice(0, 8000)}{noformat}`,
          r.steps.length ? `h4. Steps\n{noformat}${r.steps.slice(-40).join('\n')}{noformat}` : '',
          `h4. Evidence\nScreenshots and the Playwright trace are attached. Open the trace at https://trace.playwright.dev or with {{npx playwright show-trace <file>}}.`,
        ].filter(Boolean).join('\n');
        const key = await jira.createBug({
          summary: `[Automated] ${r.title} fails on ${run.environment}`,
          description,
          fingerprint: fp,
          linkTo: r.issueKeys[0],
        });
        for (const a of r.attachments) {
          if (!fs.existsSync(a.path) || fs.statSync(a.path).size > MAX_ATTACHMENT) continue;
          if (a.contentType.startsWith('image/') || a.name === 'trace' || a.contentType.startsWith('video/')) {
            await jira.attachFile(key, a.path, a.name === 'trace' ? 'trace.zip' : path.basename(a.path)).catch((e) => log(`Attachment upload to ${key} failed: ${e.message}`));
          }
        }
        published.jiraBugs.push(key);
        log(`Filed ${key} for "${r.title}"`);
      } catch (e) {
        log(`Could not file a bug for "${r.title}": ${(e as Error).message}`);
      }
    }
  }

  if (opts.octopus && run.scope?.release && cfg.octopus.publishMode !== 'none') {
    const oct = new OctopusClient(cfg);
    const rel = run.scope.release;
    try {
      if (cfg.octopus.publishMode === 'artifact' && rel.deploymentTaskId) {
        for (const f of [pdf, path.join(runDir, 'junit.xml')]) if (fs.existsSync(f)) await oct.attachArtifact(rel.deploymentTaskId, f);
        published.octopus = `Artifacts attached to deployment task ${rel.deploymentTaskId}`;
      } else {
        await oct.appendReleaseNotes(
          rel.releaseId,
          `### Automated regression: ${v.label}\n${run.environment} · ${new Date(run.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${run.totals.passed}/${run.totals.total} passed, ${run.totals.failed} failed, ${run.totals.flaky} flaky` +
            (published.jiraBugs.length ? `\n\nBugs: ${published.jiraBugs.join(', ')}` : ''),
        );
        published.octopus = `Release notes of ${rel.version} updated`;
      }
      log(published.octopus);
    } catch (e) {
      log(`Could not update Octopus: ${(e as Error).message}`);
    }
  }
  return published;
}
