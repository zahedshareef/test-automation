#!/usr/bin/env node
import readline from 'node:readline';
import { Command } from 'commander';
import { draftTests } from './ai/drafts.ts';
import { dataDir, loadConfig } from './core/config.ts';
import { isSecretName, SECRET_NAMES, secretStatus, setSecret } from './core/secrets.ts';
import type { ScopeInput } from './core/types.ts';
import { RunManager } from './runner/orchestrator.ts';
import { listTests } from './runner/playwright.ts';

const list = (v?: string) => (v ? v.split(/[\s,]+/).filter(Boolean) : undefined);

interface ScopeFlags {
  env?: string;
  jira?: string;
  jql?: string;
  octopusProject?: string;
  release?: string;
  tags?: string;
  text?: string;
  smoke: boolean;
}

function scopeFrom(o: ScopeFlags): ScopeInput {
  return {
    environment: o.env,
    jiraKeys: list(o.jira)?.map((k) => k.toUpperCase()),
    jql: o.jql,
    octopus: o.octopusProject && o.release ? { project: o.octopusProject, release: o.release } : undefined,
    tags: list(o.tags),
    freeText: o.text,
    includeAlwaysTags: o.smoke,
  };
}

const withScope = (c: Command) =>
  c
    .option('-e, --env <name>', 'environment name from Settings')
    .option('-j, --jira <keys>', 'Jira issue keys, comma-separated')
    .option('-q, --jql <jql>', 'JQL query')
    .option('--octopus-project <name>', 'Octopus project')
    .option('-r, --release <version>', 'Octopus release version')
    .option('-t, --tags <tags>', 'tags, e.g. "@smoke,@invoicing"')
    .option('--text <description>', 'free-text scope, mapped to tests by Copilot')
    .option('--no-smoke', 'do not add the always-included tags');

const program = new Command().name('qa').description('Scope-driven Playwright testing with Jira, Octopus and Copilot');

withScope(program.command('preview').description('show which tests a scope selects, without running them')).action(async (o: ScopeFlags) => {
  const p = await new RunManager().preview(scopeFrom(o), console.log);
  p.scope.notes.forEach((n) => console.log(`• ${n}`));
  console.log(`\n${p.selected.length} of ${p.catalogSize} tests selected:`);
  for (const t of p.selected) console.log(`  ${t.file} › ${t.titlePath.join(' › ')}\n      ${t.reasons.join('; ')}`);
  if (p.uncoveredIssues.length) console.log(`\nNo tests linked to: ${p.uncoveredIssues.join(', ')}`);
});

withScope(program.command('run').description('run the tests for a scope and write the report'))
  .option('--headed', 'show the browser')
  .option('--publish', 'comment on Jira issues and update Octopus when done')
  .option('--file-bugs', 'file Jira bugs for failed tests (use with care)')
  .action(async (o: ScopeFlags & { headed?: boolean; publish?: boolean; fileBugs?: boolean }) => {
    const runs = new RunManager();
    runs.on('log', (_id, line) => console.log(line));
    const run = runs.start(scopeFrom(o), { headed: o.headed });
    await new Promise((r) => runs.once('idle', r));
    let final = runs.get(run.id)!;
    if (final.status === 'completed' && (o.publish || o.fileBugs)) {
      final = await runs.publish(run.id, {
        jiraComments: Boolean(o.publish),
        octopus: Boolean(o.publish),
        bugTestIds: o.fileBugs ? final.results.filter((r) => ['failed', 'timedOut'].includes(r.outcome)).map((r) => r.id) : [],
      });
    }
    console.log(`\nReport: ${runs.runDir(run.id)}/report.html\nPDF:    ${runs.runDir(run.id)}/report.pdf`);
    process.exitCode = final.status !== 'completed' || final.totals.failed > 0 ? 1 : 0;
  });

program.command('list-tests').description('list all tests with their tags and Jira links').action(async () => {
  for (const t of await listTests()) console.log(`${t.file}:${t.line}  ${t.titlePath.join(' › ')}  ${[...t.tags, ...t.issueKeys].join(' ')}`);
});

program
  .command('draft <keys>')
  .description('use Copilot to draft tests for Jira issues into tests/drafts/')
  .option('--notes <text>', 'notes about the pages involved')
  .action(async (keys: string, o: { notes?: string }) => {
    for (const d of await draftTests(list(keys)!.map((k) => k.toUpperCase()), o.notes)) console.log(`Drafted ${d.key} → tests/${d.file}`);
  });

program
  .command('secret <name>')
  .description(`store a secret in the OS credential store (${SECRET_NAMES.join(', ')}); the value is read from a hidden prompt`)
  .action(async (name: string) => {
    if (!isSecretName(name)) throw new Error(`Unknown secret. Use one of: ${SECRET_NAMES.join(', ')}`);
    const value = await promptHidden(`${name}: `);
    setSecret(name, value);
    console.log(value ? 'Saved.' : 'Cleared.');
  });

program.command('status').description('show configuration status').action(() => {
  const cfg = loadConfig();
  console.log(`Data folder: ${dataDir()}`);
  console.log(`Environments: ${cfg.environments.map((e) => `${e.name} (${e.baseUrl})`).join(', ')}`);
  console.log('Secrets:', secretStatus());
});

program.command('serve').description('start the local web UI').action(async () => {
  await import('./server/index.ts').then(({ createServer }) => {
    const port = Number(process.env.QA_PORT ?? loadConfig().server.port);
    createServer(port).app.listen(port, '127.0.0.1', () => console.log(`Open http://localhost:${port}`));
  });
});

function promptHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => out.output.write(s.startsWith(q) ? q : '');
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

program.parseAsync().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
