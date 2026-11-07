import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../core/config.ts';
import { trimSlash } from '../core/config.ts';
import { http } from '../core/http.ts';
import { requireSecret } from '../core/secrets.ts';
import type { JiraIssue } from '../core/types.ts';

/**
 * Jira client supporting Jira Cloud (email + API token, Basic auth)
 * and Jira Data Center / Server (Personal Access Token, Bearer auth).
 * Writes use REST v2 with wiki markup, which works on both.
 */
export class JiraClient {
  private cfg: AppConfig['jira'];
  private base: string;

  constructor(cfg: AppConfig) {
    this.cfg = cfg.jira;
    if (!cfg.jira.baseUrl) throw new Error('Jira base URL is not configured.');
    this.base = trimSlash(cfg.jira.baseUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = requireSecret('jiraToken');
    const auth =
      this.cfg.deployment === 'cloud'
        ? `Basic ${Buffer.from(`${this.cfg.email}:${token}`).toString('base64')}`
        : `Bearer ${token}`;
    return { Authorization: auth, Accept: 'application/json', ...extra };
  }

  private json(method: string, apiPath: string, body?: unknown) {
    return http<any>(`${this.base}${apiPath}`, {
      method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async myself(): Promise<string> {
    const me = await this.json('GET', '/rest/api/2/myself');
    return me.displayName ?? me.name ?? 'unknown';
  }

  issueUrl(key: string): string {
    return `${this.base}/browse/${key}`;
  }

  async search(jql: string, max = 50): Promise<JiraIssue[]> {
    const fields = ['summary', 'issuetype', 'status', 'components', 'labels', 'description'];
    if (this.cfg.acceptanceCriteriaField) fields.push(this.cfg.acceptanceCriteriaField);
    // Jira Cloud retired /rest/api/{2,3}/search in favour of /rest/api/3/search/jql.
    const res =
      this.cfg.deployment === 'cloud'
        ? await this.json('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: max })
        : await this.json('POST', '/rest/api/2/search', { jql, fields, maxResults: max });
    return (res.issues ?? []).map((i: any) => this.toIssue(i));
  }

  async getIssues(keys: string[]): Promise<JiraIssue[]> {
    if (keys.length === 0) return [];
    const safe = keys.filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
    return this.search(`key in (${safe.join(',')})`, safe.length);
  }

  private toIssue(i: any): JiraIssue {
    const f = i.fields ?? {};
    const ac = this.cfg.acceptanceCriteriaField ? f[this.cfg.acceptanceCriteriaField] : undefined;
    return {
      key: i.key,
      summary: f.summary ?? '',
      type: f.issuetype?.name ?? '',
      status: f.status?.name ?? '',
      components: (f.components ?? []).map((c: any) => c.name),
      labels: f.labels ?? [],
      description: toText(f.description),
      acceptanceCriteria: toText(ac),
      url: this.issueUrl(i.key),
    };
  }

  async addComment(key: string, wikiBody: string): Promise<void> {
    await this.json('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: wikiBody });
  }

  /** Finds an open bug previously filed for the same failure (matched by a fingerprint label). */
  async findOpenBugByFingerprint(fingerprint: string): Promise<string | undefined> {
    const jql = `project = "${this.cfg.projectKey}" AND labels = "${fingerprint}" AND statusCategory != Done`;
    const hits = await this.search(jql, 1);
    return hits[0]?.key;
  }

  async createBug(opts: { summary: string; description: string; fingerprint: string; linkTo?: string }): Promise<string> {
    if (!this.cfg.projectKey) throw new Error('Jira project key for bugs is not configured.');
    const res = await this.json('POST', '/rest/api/2/issue', {
      fields: {
        project: { key: this.cfg.projectKey },
        issuetype: { name: this.cfg.bugIssueType },
        summary: opts.summary.slice(0, 250),
        description: opts.description,
        labels: [...this.cfg.bugLabels, opts.fingerprint],
      },
    });
    const key: string = res.key;
    if (opts.linkTo) {
      await this.json('POST', '/rest/api/2/issueLink', {
        type: { name: 'Relates' },
        inwardIssue: { key },
        outwardIssue: { key: opts.linkTo },
      }).catch(() => undefined); // Link type names vary per instance; the bug is still useful without it.
    }
    return key;
  }

  async attachFile(key: string, filePath: string, fileName = path.basename(filePath)): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)]), fileName);
    await http(`${this.base}/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      headers: this.headers({ 'X-Atlassian-Token': 'no-check' }),
      body: form,
      timeoutMs: 120_000,
    });
  }
}

/** Converts a Jira field (plain string, wiki markup or Atlassian Document Format) to plain text. */
export function toText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return adfToText(value as AdfNode).replace(/\n{3,}/g, '\n\n').trim();
  return String(value);
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function adfToText(node: AdfNode, depth = 0): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return String(node.attrs?.text ?? '');
  const children = (node.content ?? []).map((c) => adfToText(c, depth + 1));
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return children.join('') + '\n';
    case 'bulletList':
    case 'orderedList':
      return children.join('');
    case 'listItem':
      return `${'  '.repeat(Math.max(0, depth - 2))}- ${children.join('').trim()}\n`;
    case 'codeBlock':
      return '```\n' + children.join('') + '\n```\n';
    case 'tableRow':
      return '| ' + children.map((c) => c.trim()).join(' | ') + ' |\n';
    default:
      return children.join('');
  }
}
