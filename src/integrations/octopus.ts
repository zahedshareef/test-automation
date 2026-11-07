import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../core/config.ts';
import { trimSlash } from '../core/config.ts';
import { http } from '../core/http.ts';
import { requireSecret } from '../core/secrets.ts';
import type { OctopusReleaseInfo } from '../core/types.ts';

const JIRA_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const IS_JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export class OctopusClient {
  private base: string;
  private spaceSetting: string;
  private spaceId?: string;

  constructor(cfg: AppConfig) {
    if (!cfg.octopus.serverUrl) throw new Error('Octopus server URL is not configured.');
    this.base = trimSlash(cfg.octopus.serverUrl);
    this.spaceSetting = cfg.octopus.space || 'Spaces-1';
  }

  private req<T = any>(method: string, apiPath: string, body?: unknown, raw = false): Promise<T> {
    const headers: Record<string, string> = { 'X-Octopus-ApiKey': requireSecret('octopusApiKey'), Accept: 'application/json' };
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = 'application/octet-stream';
    return http<T>(`${this.base}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
      timeoutMs: 120_000,
    });
  }

  async me(): Promise<string> {
    const u = await this.req('GET', '/api/users/me');
    return u.DisplayName ?? u.Username;
  }

  /** Accepts a space id ("Spaces-1") or a space name. */
  async space(): Promise<string> {
    if (this.spaceId) return this.spaceId;
    if (/^Spaces-\d+$/.test(this.spaceSetting)) return (this.spaceId = this.spaceSetting);
    const spaces: any[] = await this.req('GET', '/api/spaces/all');
    const s = spaces.find((x) => x.Name.toLowerCase() === this.spaceSetting.toLowerCase());
    if (!s) throw new Error(`Octopus space "${this.spaceSetting}" not found.`);
    return (this.spaceId = s.Id as string);
  }

  async findProject(nameOrSlug: string): Promise<{ Id: string; Name: string }> {
    const sp = await this.space();
    const res = await this.req('GET', `/api/${sp}/projects?partialName=${encodeURIComponent(nameOrSlug)}&take=50`);
    const want = nameOrSlug.toLowerCase();
    const p = (res.Items as any[]).find((x) => x.Name.toLowerCase() === want || x.Slug?.toLowerCase() === want);
    if (!p) throw new Error(`Octopus project "${nameOrSlug}" not found in ${sp}.`);
    return p;
  }

  async listReleases(projectName: string, take = 20): Promise<{ version: string; created: string }[]> {
    const sp = await this.space();
    const p = await this.findProject(projectName);
    const res = await this.req('GET', `/api/${sp}/projects/${p.Id}/releases?take=${take}`);
    return (res.Items as any[]).map((r) => ({ version: r.Version, created: r.Assembled }));
  }

  async getRelease(projectName: string, version: string, environmentName?: string): Promise<OctopusReleaseInfo> {
    const sp = await this.space();
    const p = await this.findProject(projectName);
    const r = await this.req('GET', `/api/${sp}/projects/${p.Id}/releases/${encodeURIComponent(version)}`);

    // Jira keys come from build information work items (Octopus Jira integration)
    // and, as a fallback, from any keys mentioned in the release notes.
    const keys = new Set<string>();
    for (const bi of r.BuildInformation ?? []) {
      for (const wi of bi.WorkItems ?? []) if (typeof wi.Id === 'string' && IS_JIRA_KEY.test(wi.Id)) keys.add(wi.Id);
    }
    for (const m of String(r.ReleaseNotes ?? '').matchAll(JIRA_KEY)) keys.add(m[0]);

    const info: OctopusReleaseInfo = {
      projectId: p.Id,
      projectName: p.Name,
      releaseId: r.Id,
      version: r.Version,
      releaseNotes: r.ReleaseNotes ?? '',
      workItemKeys: [...keys],
    };

    if (environmentName) {
      const envs = await this.req('GET', `/api/${sp}/environments?partialName=${encodeURIComponent(environmentName)}&take=20`);
      const env = (envs.Items as any[]).find((e) => e.Name.toLowerCase() === environmentName.toLowerCase());
      if (env) {
        const deps = await this.req('GET', `/api/${sp}/releases/${r.Id}/deployments?take=50`);
        const latest = (deps.Items as any[])
          .filter((d) => d.EnvironmentId === env.Id)
          .sort((a, b) => String(b.Created).localeCompare(String(a.Created)))[0];
        if (latest) {
          info.deploymentTaskId = latest.TaskId;
          info.environment = env.Name;
        }
      }
    }
    return info;
  }

  /** Uploads a file as an artifact on the deployment's server task (shown on the deployment page). */
  async attachArtifact(taskId: string, filePath: string): Promise<string> {
    const sp = await this.space();
    const art = await this.req('POST', `/api/${sp}/artifacts`, {
      Filename: path.basename(filePath),
      ServerTaskId: taskId,
    });
    const contentPath: string = art.Links?.Content ?? `/api/${sp}/artifacts/${art.Id}/content`;
    await this.req('PUT', contentPath, fs.readFileSync(filePath), true);
    return art.Id;
  }

  /** Appends (or replaces) an automated test results section in the release notes. */
  async appendReleaseNotes(releaseId: string, markdown: string): Promise<void> {
    const sp = await this.space();
    const r = await this.req('GET', `/api/${sp}/releases/${releaseId}`);
    const marker = '<!-- qa-automation -->';
    const existing = String(r.ReleaseNotes ?? '').split(marker)[0].trimEnd();
    r.ReleaseNotes = `${existing}\n\n${marker}\n${markdown}`;
    await this.req('PUT', `/api/${sp}/releases/${releaseId}`, r);
  }
}
