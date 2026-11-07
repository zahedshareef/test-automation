import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CopilotAI } from '../ai/copilot.ts';
import { deleteDraft, draftTests, listDrafts, promoteDraft, saveDraft } from '../ai/drafts.ts';
import { type AppConfig, loadConfig, saveConfig } from '../core/config.ts';
import { isSecretName, secretStatus, setSecret } from '../core/secrets.ts';
import { JiraClient } from '../integrations/jira.ts';
import { OctopusClient } from '../integrations/octopus.ts';
import { RunManager } from '../runner/orchestrator.ts';
import { listTests, ROOT } from '../runner/playwright.ts';

/**
 * Local web UI for testers. Security model:
 *  - Listens on 127.0.0.1 only, so it is not reachable from the network.
 *  - Host header must be localhost/127.0.0.1, which blocks DNS-rebinding attacks.
 *  - A random per-launch session token is set as an HttpOnly SameSite=Strict cookie,
 *    and state-changing requests must also send it in a header (CSRF protection).
 *  - Secrets are write-only: the API reports only whether each one is set.
 */
export function createServer(port: number) {
  const app = express();
  const token = crypto.randomBytes(32).toString('hex');
  const runs = new RunManager();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return res.status(403).send('Forbidden host');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  const cookieOk = (req: Request) => (req.headers.cookie ?? '').split(/;\s*/).includes(`qa_session=${token}`);
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!cookieOk(req)) return res.status(401).json({ error: 'Session expired. Reload the page.' });
    if (req.method !== 'GET' && req.headers['x-qa-token'] !== token) return res.status(403).json({ error: 'Missing CSRF token' });
    next();
  };

  // UI shell: sets the session cookie and embeds the CSRF token (unreadable by other origins).
  const indexHtml = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  app.get('/', (_req, res) => {
    res.setHeader('Set-Cookie', `qa_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    res.type('html').send(indexHtml.replace('__QA_TOKEN__', token));
  });
  app.use('/static', express.static(path.join(ROOT, 'web'), { index: false }));

  // Run artifacts (report.html, screenshots, Playwright report) for the browser.
  app.use('/runs/:id', (req, res, next) => {
    if (!cookieOk(req)) return res.status(401).send('Open the tool from its home page first.');
    try {
      express.static(runs.runDir(String(req.params.id)), { index: ['report.html'], dotfiles: 'deny' })(req, res, next);
    } catch {
      res.status(400).end();
    }
  });

  const api = express.Router();
  api.use(guard);
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };

  api.get('/config', wrap(() => ({ config: loadConfig(), secrets: secretStatus(), busy: runs.busy })));
  api.put('/config', wrap((req) => {
    const cfg = req.body as AppConfig;
    if (!Array.isArray(cfg?.environments) || cfg.environments.length === 0) throw new Error('At least one environment is required.');
    for (const e of cfg.environments) new URL(e.baseUrl);
    saveConfig(cfg);
  }));
  api.put('/secrets/:name', wrap((req) => {
    const name = String(req.params.name);
    if (!isSecretName(name)) throw new Error('Unknown secret');
    setSecret(name, String(req.body?.value ?? ''));
    return { secrets: secretStatus() };
  }));
  api.post('/test-connection/:target', wrap(async (req) => {
    const cfg = loadConfig();
    switch (req.params.target) {
      case 'jira': return { message: `Connected to Jira as ${await new JiraClient(cfg).myself()}` };
      case 'octopus': return { message: `Connected to Octopus as ${await new OctopusClient(cfg).me()}` };
      case 'ai': return { message: `Copilot replied: ${await new CopilotAI(cfg).ping()}` };
      default: throw new Error('Unknown target');
    }
  }));

  api.get('/catalog', wrap(async () => ({ tests: await listTests() })));
  api.get('/octopus/releases', wrap(async (req) => ({ releases: await new OctopusClient(loadConfig()).listReleases(String(req.query.project ?? '')) })));
  api.post('/preview', wrap(async (req) => runs.preview(req.body)));

  api.get('/runs', wrap(() => ({ runs: runs.list().map(({ results, selected, ...r }) => ({ ...r, selectedCount: selected.length })), busy: runs.busy })));
  api.post('/runs', wrap((req) => runs.start(req.body.scope ?? {}, { headed: req.body.headed })));
  api.get('/runs/:id', wrap((req) => {
    const run = runs.get(String(req.params.id));
    if (!run) throw new Error('Run not found');
    return { run, log: runs.readLog(run.id) };
  }));
  api.post('/runs/:id/cancel', wrap((req) => ({ cancelled: runs.cancel(String(req.params.id)) })));
  api.post('/runs/:id/publish', wrap(async (req) => runs.publish(String(req.params.id), {
    jiraComments: Boolean(req.body.jiraComments),
    bugTestIds: Array.isArray(req.body.bugTestIds) ? req.body.bugTestIds.map(String) : [],
    octopus: Boolean(req.body.octopus),
  })));

  // Live log: newline-delimited JSON stream (fetch-based, so it carries the auth cookie).
  api.get('/runs/:id/stream', (req, res) => {
    const id = String(req.params.id);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const onLog = (runId: string, line: string) => runId === id && res.write(JSON.stringify({ log: line }) + '\n');
    const onUpdate = (run: { id: string; status: string }) => run.id === id && res.write(JSON.stringify({ status: run.status }) + '\n');
    runs.on('log', onLog);
    runs.on('update', onUpdate);
    const ping = setInterval(() => res.write('{}\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      runs.off('log', onLog);
      runs.off('update', onUpdate);
    });
  });

  api.get('/drafts', wrap(() => ({ drafts: listDrafts() })));
  api.post('/drafts', wrap(async (req) => ({ created: await draftTests((req.body.keys ?? []).map(String), req.body.pageNotes) })));
  api.put('/drafts/:name', wrap((req) => saveDraft(String(req.params.name), String(req.body.content ?? ''))));
  api.post('/drafts/:name/promote', wrap((req) => ({ file: promoteDraft(String(req.params.name)) })));
  api.delete('/drafts/:name', wrap((req) => deleteDraft(String(req.params.name))));

  app.use('/api', api);
  return { app, runs };
}

if (import.meta.main) {
  const port = Number(process.env.QA_PORT ?? loadConfig().server.port);
  const { app } = createServer(port);
  app.listen(port, '127.0.0.1', () => {
    console.log(`QA automation tool running at http://localhost:${port} (local only)`);
  });
}
