# AGENTS.md

Guidance for AI coding agents (GitHub Copilot agent mode, Claude Code, Codex, and others) working in this repository. Human contributors should read [README.md](README.md) first.

## What this project is

A local tool that testers run on their own PCs. It takes a **scope** (Jira issues or JQL, an Octopus release, tags, or free text), selects Playwright tests, runs them against a deployed **.NET Blazor WebAssembly** test site that signs in through **Duende IdentityServer** (on-prem AD), and produces HTML, PDF and JUnit reports. After the tester reviews the results, it can publish them to **Jira Data Center**, **Octopus Deploy**, and use **GitHub Copilot** for selection, drafting, triage and summaries.

There are two halves:

| Half | Location | Runs under |
|---|---|---|
| The tool (server, CLI, integrations, reports) | `src/`, `web/` | Node.js 22.18+ with native TypeScript type stripping (no build step) |
| The test suite | `tests/`, `playwright.config.ts` | Playwright Test (its own TS transform) |

## Commands

```bash
npm install            # also installs Playwright Chromium
npm start              # web UI at http://localhost:4870
npm run typecheck      # tsc for src/ AND tests/ (two tsconfigs). Must pass.
npm run test:unit      # node:test unit tests in src/**/*.test.ts. Must pass.
npm run test:list      # lists Playwright tests; catches syntax/import errors in tests/
node src/cli.ts --help # CLI: preview, run, list-tests, draft, secret, status, serve
```

Run `typecheck` and `test:unit` before you finish any change. If you change `tests/`, also run `test:list`.

## Code conventions

### `src/` (run directly by Node)
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x)`), and no `import x = require()`. Use union types and plain fields instead.
- **Relative imports must end in `.ts`** (`import { x } from './foo.ts'`). Type-only imports must use `import type` (`verbatimModuleSyntax`).
- ESM only (`"type": "module"`). Use `import.meta.dirname`, not `__dirname`.
- Prefer Node built-ins (`fetch`, `FormData`, `node:test`, `crypto`). Ask before adding a dependency.
- HTTP calls go through `src/core/http.ts`. Errors must not include secrets.

### `tests/` (run by Playwright)
- Imports are **extensionless** (`from '../support/fixtures'`). `tests/tsconfig.json` uses bundler resolution.
- Always `import { test, expect } from '../support/fixtures'`, never straight from `@playwright/test` (except in `auth.setup.ts`). The fixtures restore the OIDC session and guard against the Blazor error banner.
- Navigate with `app.goto(path)`, not `page.goto`, so the test waits for Blazor to boot. Use relative paths: the base URL may include a virtual directory.
- Use role, label or text locators (`getByRole`, `getByLabel`). **Never use `waitForTimeout`** or fixed sleeps.
- Link tests to scope with metadata, which is how selection works:
  ```ts
  test('title describing behaviour', {
    tag: ['@regression', '@area'],
    annotation: [{ type: 'issue', description: 'APP-123' }],
  }, async ({ app, page }) => { ... });
  ```
- Test titles must not contain `›` (it is the `--test-list` separator).
- `tests/drafts/` holds AI drafts. Playwright ignores it (in **both** the global and the chromium project `testIgnore`; keep them in sync). Never make drafts runnable automatically.

### `web/`
- Plain HTML, CSS and ES modules. No framework, no build, no CDN (CSP is `default-src 'self'`; inline scripts are blocked).
- Insert any server or Jira text with the `esc()` helper. Jira content is untrusted.
- Every API call goes through `api()`, which sends the CSRF header.

## Invariants you must not break

1. **Secrets** (Jira PAT, Octopus API key, GitHub token, test-user password) live only in the OS credential store (`src/core/secrets.ts`) or `QA_*` environment variables. Never write them to `config.json`, logs, reports, run folders or API responses, and never send them to Copilot. Pass log and AI text through `redact()`.
2. **The server is local-only**: it binds `127.0.0.1`, checks the Host header, requires the SameSite=Strict session cookie, and requires the CSRF header on non-GET requests. Don't relax any of these, and don't add CORS.
3. **Nothing is published without review.** Jira comments, bugs and Octopus updates happen only through `RunManager.publish`, which the user triggers from the UI or with explicit CLI flags. Never call publish automatically at the end of a run.
4. **Bug deduplication**: bugs carry a `qa-fp-<hash>` label from `fingerprint()`. Changing how fingerprints are computed creates duplicate bugs, so don't.
5. **Run data** lives in the per-user data dir (`%LOCALAPPDATA%\QaTool`, `~/.qa-tool`, or `QA_DATA_DIR`), never in the repo. Saved sign-in state is in `<data>/auth/`.
6. Jira writes use **REST v2 with wiki markup** (the team uses Jira Data Center). Keep Cloud support working: search goes through `/rest/api/3/search/jql`, and the description may be ADF (`toText`).

## Architecture map

| Concern | File |
|---|---|
| Config shape and defaults, data dir | `src/core/config.ts` |
| Shared types (`ScopeInput`, `RunSummary`, …) | `src/core/types.ts` |
| Scope → issues and tags → selected tests | `src/scope/resolve.ts` |
| Playwright discovery, run, results parsing | `src/runner/playwright.ts` |
| Run lifecycle, history, live log events | `src/runner/orchestrator.ts` |
| Report HTML/PDF | `src/report/html.ts` |
| Jira, bugs, Octopus publishing | `src/report/publish.ts` |
| Jira / Octopus clients | `src/integrations/` |
| Copilot chat client and prompts; AI drafts | `src/ai/copilot.ts`, `src/ai/drafts.ts` |
| HTTP API and security middleware | `src/server/index.ts` |
| Duende sign-in, sessionStorage capture | `tests/auth.setup.ts` |
| Fixtures (`app.goto`, Blazor guard) | `tests/support/fixtures.ts`, `tests/support/blazor.ts` |

The tool passes settings to Playwright only through `QA_*` environment variables (see `playwright.config.ts` and `startRun`). If you add a setting the tests need, add it there too.

## Testing your change without real systems

No real Jira, Octopus or test site is needed for most work:
- Unit tests cover pure logic. Add a case to `src/core/logic.test.ts` (or a new `*.test.ts`) for selection, parsing or formatting changes.
- For an end-to-end check, publish the Blazor template (`dotnet new blazorwasm -o demo && dotnet publish demo -c Release -o demo/out`), serve `demo/out/wwwroot` with an SPA fallback, and point a throwaway data dir at it. Set `QA_DATA_DIR=<tmp>` with an environment of `"authMode": "none"`, then run `node src/cli.ts run --tags @smoke`. Mock Jira and Octopus with a tiny local HTTP server, and pass secrets as `QA_JIRA_TOKEN=dummy` and so on. Keep that scaffolding **outside the repo**.
- Never point experiments at the team's real Jira or Octopus, and never use real credentials.

## Pull requests

- Keep each PR to one concern. Describe user-visible behaviour changes, and update `README.md` when setup or usage changes.
- Don't commit `node_modules/`, `.auth/`, `test-results/`, `playwright-report/`, run output, or anything containing a token.
