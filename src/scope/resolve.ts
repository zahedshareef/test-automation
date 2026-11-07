import type { CopilotAI } from '../ai/copilot.ts';
import type { AppConfig } from '../core/config.ts';
import { getEnvironment } from '../core/config.ts';
import type { CatalogTest, JiraIssue, ResolvedScope, ScopeInput, SelectedTest } from '../core/types.ts';
import { JiraClient } from '../integrations/jira.ts';
import { OctopusClient } from '../integrations/octopus.ts';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
export const normaliseTag = (t: string): string => `@${t.trim().replace(/^@/, '')}`;

/**
 * Turns the tester's scope (Jira keys/JQL, Octopus release, tags, free text)
 * into the Jira issues and tags in scope.
 */
export async function resolveScope(input: ScopeInput, cfg: AppConfig, log: (m: string) => void): Promise<ResolvedScope> {
  const notes: string[] = [];
  const env = getEnvironment(cfg, input.environment);
  const keys = new Set((input.jiraKeys ?? []).map((k) => k.trim().toUpperCase()).filter((k) => KEY.test(k)));
  let release: ResolvedScope['release'];

  if (input.octopus?.project && input.octopus.release) {
    log(`Looking up Octopus release ${input.octopus.project} ${input.octopus.release}...`);
    release = await new OctopusClient(cfg).getRelease(input.octopus.project, input.octopus.release, env.octopusEnvironment);
    release.workItemKeys.forEach((k) => keys.add(k));
    notes.push(`Octopus release ${release.version} links ${release.workItemKeys.length} Jira issue(s)${release.deploymentTaskId ? ` and was deployed to ${release.environment}` : ''}.`);
    if (!release.deploymentTaskId) notes.push(`Release ${release.version} has no deployment to "${env.octopusEnvironment ?? '?'}". Check that the test site is running this version.`);
  }

  let issues: JiraIssue[] = [];
  if (keys.size || input.jql) {
    if (!cfg.jira.baseUrl) {
      notes.push('Jira is not configured, so issues are matched by key only.');
      issues = [...keys].map((key) => ({ key, summary: '', type: '', status: '', components: [], labels: [], description: '', acceptanceCriteria: '', url: '' }));
    } else {
      const jira = new JiraClient(cfg);
      log(`Fetching ${keys.size} Jira issue(s)${input.jql ? ' and running JQL' : ''}...`);
      const byKey = new Map<string, JiraIssue>();
      for (const i of await jira.getIssues([...keys])) byKey.set(i.key, i);
      if (input.jql) for (const i of await jira.search(input.jql, 100)) byKey.set(i.key, i);
      issues = [...byKey.values()];
      const missing = [...keys].filter((k) => !byKey.has(k));
      if (missing.length) notes.push(`Not found in Jira (or no permission): ${missing.join(', ')}`);
    }
  }

  const tags = new Set((input.tags ?? []).filter(Boolean).map(normaliseTag));
  for (const issue of issues) {
    for (const name of [...issue.components, ...issue.labels]) {
      const mapped = cfg.jira.componentTagMap[name];
      if (mapped) {
        tags.add(normaliseTag(mapped));
        notes.push(`${issue.key}: "${name}" maps to ${normaliseTag(mapped)}`);
      }
    }
  }
  if (input.includeAlwaysTags !== false) cfg.run.alwaysIncludeTags.forEach((t) => tags.add(normaliseTag(t)));

  return { input, issues, tags: [...tags], release, notes };
}

/** Picks tests from the catalog for a resolved scope. Free text is mapped by Copilot. */
export async function selectTests(
  scope: ResolvedScope,
  catalog: CatalogTest[],
  ai: CopilotAI | undefined,
  log: (m: string) => void,
): Promise<{ selected: SelectedTest[]; uncoveredIssues: string[] }> {
  const reasons = new Map<string, string[]>();
  const add = (t: CatalogTest, why: string) => {
    const k = `${t.project}|${t.id}`;
    reasons.set(k, [...(reasons.get(k) ?? []), why]);
  };
  const issueKeys = new Set(scope.issues.map((i) => i.key));

  for (const t of catalog) {
    for (const k of t.issueKeys) if (issueKeys.has(k)) add(t, `Linked to ${k}`);
    for (const tag of t.tags) if (scope.tags.includes(tag)) add(t, `Tagged ${tag}`);
  }

  const text = scope.input.freeText?.trim();
  if (text) {
    if (ai?.enabled) {
      log('Asking Copilot which tests match the free-text scope...');
      const pick = await ai.selectTests(text, catalog);
      for (const t of catalog) {
        if (pick.testIds.includes(t.id)) add(t, `Copilot: ${pick.rationale.slice(0, 160)}`);
        for (const tag of t.tags) if (pick.tags.includes(tag)) add(t, `Copilot picked ${tag}`);
      }
      scope.notes.push(`Copilot: ${pick.rationale}`);
    } else {
      // No AI available: keyword match against titles and tags.
      const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      for (const t of catalog) {
        const hay = `${t.titlePath.join(' ')} ${t.tags.join(' ')}`.toLowerCase();
        const hit = words.filter((w) => hay.includes(w));
        if (hit.length) add(t, `Keyword match: ${hit.join(', ')}`);
      }
      scope.notes.push('Copilot is not configured, so free text was matched by keywords.');
    }
  }

  const selected = catalog.filter((t) => reasons.has(`${t.project}|${t.id}`)).map((t) => ({ ...t, reasons: reasons.get(`${t.project}|${t.id}`)! }));
  const covered = new Set(selected.flatMap((t) => t.issueKeys));
  const uncoveredIssues = scope.issues.map((i) => i.key).filter((k) => !covered.has(k));
  return { selected, uncoveredIssues };
}
