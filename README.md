# QA Automation Tool

Scope-driven automated testing for the deployed Blazor WebAssembly test site. A tester gives a **scope**: Jira issues or JQL, an Octopus release, tags, or a plain-English description. The tool picks the matching Playwright tests, runs them against the test environment, and produces a full report (HTML, PDF and JUnit). After the tester reviews the results, it can comment on the Jira issues, file deduplicated Jira bugs with evidence, and record the result on the Octopus deployment.

```
 Scope ──► Resolve ──────────────────► Select ───────────────► Run ───────────► Report ─────────► Publish (after review)
 Jira keys / JQL      Octopus release → work items       linked tests (annotation)   Playwright, signed in   HTML · PDF · JUnit     Jira comments + PDF
 Octopus release      Jira → issues, components → tags   tags                        via Duende, Blazor-     traceability matrix    Jira bugs (deduplicated)
 Tags / free text     always-include tags (@smoke)       Copilot picks for free text aware waits, retries    Copilot triage/summary Octopus artifacts / notes
```

## Requirements

- Node.js 22.18 or later (the TypeScript runs directly, with no build step)
- Windows 10/11 or macOS. Secrets go into Windows Credential Manager or the macOS Keychain.
- Network access from the tester's PC to the test site, Jira, Octopus and GitHub

## Install on a tester's PC

1. Install **Node.js 22.18 or later** (LTS from nodejs.org) and **Git**.
2. Clone and install:
   ```powershell
   git clone https://github.com/zahedshareef/test-automation.git
   cd test-automation
   npm install                      # also downloads Playwright's Chromium (~150 MB)
   ```
   Behind a corporate proxy, set `HTTPS_PROXY` before `npm install`. If Chromium can't be downloaded, set `PLAYWRIGHT_DOWNLOAD_HOST` to your internal mirror.
3. Start the tool:
   ```powershell
   npm start                        # then open http://localhost:4870
   ```
   It runs until you close that terminal or press Ctrl-C. To start it automatically at sign-in, see below.
4. Fill in **Settings** (next section), click **Save settings**, then **Test connection** for Jira, Octopus and Copilot.
5. Do a first run: New run → Tags `@smoke` → *Start run*. This checks that the site, the sign-in and the browser all work.

To update later: `git pull` then `npm install`, and restart the tool.

To start it automatically at sign-in, with a Start menu shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

> **Why not a Windows service?** A service runs in session 0 under a service account. It can't show a browser for headed runs, and it can't read the tester's Credential Manager. A per-user logon task keeps every secret in the tester's own credential store, and the server only listens on `127.0.0.1`.

## First-time setup (Settings tab)

| Section | What to enter |
|---|---|
| Environments | Name, base URL (e.g. `https://test.portal.company.local/`), sign-in mode `Duende`, and the matching Octopus environment name |
| Test account | The AD test account's username and password. The password is saved to Credential Manager. |
| Jira | Base URL, **Data Center/Server** (Personal Access Token) or **Cloud** (email and API token), project for bugs, acceptance-criteria custom field, component → tag map |
| Octopus | Server URL, space, API key, and how to record results (artifacts on the deployment, or a section in the release notes) |
| GitHub Copilot | GHE URL, token, an OpenAI-compatible chat-completions endpoint, and the model (see "Copilot endpoint" below) |

Use the **Test connection** buttons after saving. For unattended use, secrets can also come from environment variables: `QA_JIRA_TOKEN`, `QA_OCTOPUS_API_KEY`, `QA_GITHUB_TOKEN`, `QA_TEST_USER_PASSWORD`.

## Daily use

**UI:** New run → enter a scope → *Preview selection* (shows each selected test and why it was picked) → *Start run* → watch the live log → open the report → tick the failures that are real defects → *Publish*.

**CLI** (the same engine):

```powershell
node src/cli.ts preview --octopus-project "Customer Portal" --release 1.4.2
node src/cli.ts run --jira APP-123,APP-456 --tags @invoicing
node src/cli.ts run --jql 'fixVersion = "2026.11"' --publish          # comment on Jira and update Octopus
node src/cli.ts run --text "invoice export and totals" --headed
node src/cli.ts draft APP-789                                         # Copilot drafts a test for review
node src/cli.ts secret jiraToken                                      # store a secret from a hidden prompt
```

`run` exits with code 1 when any test fails, so it can gate a script.

## How tests are linked to scope

```ts
import { test, expect } from '../support/fixtures';

test('user can export an invoice as PDF', {
  tag: ['@regression', '@invoicing'],                    // tag scope, and the component → tag map
  annotation: [{ type: 'issue', description: 'APP-123' }], // Jira and Octopus scope
}, async ({ app, page }) => {
  await app.goto('/invoices');                            // waits for Blazor to finish booting
  // ...
});
```

- Jira issues in scope with no linked test appear as **uncovered** in the preview and the report. The Drafts tab can ask Copilot to draft tests for them.
- **AI drafts** go to `tests/drafts/` and are never run. A tester reviews each one and fixes every `TODO(review)`, then clicks *Promote*, which moves it to `tests/regression/`. Then they commit it. This is the hybrid model: humans own the suite, and Copilot speeds up writing it.

## What the suite handles for Blazor WASM and Duende

- **Sign-in once per run** through Duende (`tests/auth.setup.ts`), reused for 20 minutes. Fields are found by label. If your login page is customised, set CSS selectors in Settings.
- **sessionStorage tokens:** the Blazor WASM OIDC library keeps tokens in `sessionStorage`, which Playwright's `storageState` doesn't save. The setup captures it, and the fixtures restore it before the app starts.
- **Blazor readiness:** `app.goto()` waits for the runtime to boot, the loading placeholder to clear, and "Authorizing…" to finish. Optionally set `QA_APP_READY_SELECTOR` to an element your app always renders.
- **Automatic guards:** every test fails if `#blazor-error-ui` is visible, and console errors are attached.
- **Built-in suites:** `@smoke` (boot, signed-in check, every nav-menu link) and `@a11y` (axe WCAG 2.1 AA; set pages in `QA_A11Y_PATHS`).

## The report

`report.html` and `report.pdf` contain: a verdict, environment, release and scope; totals and pass rate; a Copilot executive summary; a **requirement traceability matrix** (Jira issue → tests → result); failure details with error, steps, screenshot and Copilot triage; flaky tests; page-readiness timings; all tests; and the reason each test was selected. The Playwright HTML report (with traces and videos), JUnit XML and raw JSON sit next to it. Runs are stored in `%LOCALAPPDATA%\QaTool\runs\`.

## Publishing behaviour

- Nothing is sent to Jira or Octopus until the tester clicks **Publish** (or passes `--publish` on the CLI).
- **Bugs are deduplicated:** each failing test gets a fingerprint label (`qa-fp-…`). If an open bug already has it, the tool adds a "failed again" comment instead of filing a new bug. Bugs include the error, steps, Copilot triage, screenshot, video and trace, and link to the related story.
- **Octopus:** in `artifact` mode, the PDF and JUnit XML are attached to the deployment task for the configured environment. In `releaseNotes` mode, a results section is added to (or replaced in) the release notes.

## Security

- The server binds to `127.0.0.1` only. It rejects foreign `Host` headers (DNS rebinding), uses an HttpOnly SameSite=Strict session cookie, and requires a per-launch CSRF token on every write.
- Tokens and passwords are kept only in the OS credential store. The API reports only whether each is set. Values are redacted from logs, reports and anything sent to Copilot.
- The sign-in session (`%LOCALAPPDATA%\QaTool\auth\`) is per user and outside the repo.

## Verify against your instances

These were built from the public API docs and tested against mocks, but not yet against your servers:

1. **Copilot endpoint:** the default is GitHub Models (`https://models.github.ai/inference/chat/completions`) with a token that has the `models:read` scope. Your enterprise may need an org-attributed endpoint (`https://models.github.ai/orgs/<org>/inference/chat/completions`) or a different gateway. GitHub Enterprise Server (self-hosted) doesn't host GitHub Models itself. Any OpenAI-compatible endpoint works.
2. **Jira:** pick Data Center or Cloud correctly. Cloud search uses `/rest/api/3/search/jql`. The "Relates" link type name can differ per instance (linking is skipped if it fails).
3. **Octopus artifacts:** uses `POST /api/{space}/artifacts` and then `PUT …/content`. If your version rejects this, switch to `releaseNotes` mode.
4. **Duende login page:** if fields aren't found by label, set the selectors in Settings.

## Project layout

```
src/
  cli.ts                 CLI
  server/index.ts        local web server and API
  core/                  config, secret store, types, HTTP helper
  integrations/          Jira and Octopus clients
  ai/                    Copilot client, AI test drafting
  scope/resolve.ts       scope resolution and test selection
  runner/                Playwright discovery/run/parse, run orchestration
  report/                HTML/PDF report, publishing
web/                     UI (plain HTML/JS/CSS, no build)
tests/
  auth.setup.ts          Duende sign-in
  support/               fixtures (app.goto, Blazor guards), Blazor helpers
  smoke/ a11y/ regression/
  drafts/                AI drafts awaiting review (never run)
playwright.config.ts
scripts/install-autostart.ps1
```

## Contributing

Testers add and maintain tests here, and anyone can improve the tool.

1. Create a branch: `git checkout -b test/APP-123-invoice-export` (or `feat/…`, `fix/…`).
2. Write tests in `tests/regression/<area>.spec.ts`, starting from `tests/regression/_template.spec.ts`. Tag each test and link it to its Jira issue (see "How tests are linked to scope").
3. Try the test locally: `npx playwright test tests/regression/<file> --headed`, with `QA_BASE_URL`, `QA_TEST_USER` and `QA_TEST_USER_PASSWORD` set in your shell. Or run it from the tool with a tag scope.
4. Run the checks, which must pass:
   ```powershell
   npm run typecheck
   npm run test:unit
   npm run test:list
   ```
5. Push the branch and open a pull request.

Rules: never commit credentials, `.auth/`, or run output (`.gitignore` covers the usual paths). Promote AI drafts only after a human has reviewed them.

**AI agents** (Copilot agent mode, Claude Code and others) should follow [AGENTS.md](AGENTS.md). It lists the code conventions and the security rules that must not be broken.
