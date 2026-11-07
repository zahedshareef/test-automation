const TOKEN = document.querySelector('meta[name=qa-token]').content;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const badge = (s) => `<span class="b ${esc(s)}">${esc(s)}</span>`;
const splitList = (s) => String(s ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-QA-Token': TOKEN },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), error ? 8000 : 3500);
}

async function busyButton(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = label; }
}

/* ---------- tabs ---------- */
function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${name}`));
  if (name === 'runs') loadRuns();
  if (name === 'drafts') loadDrafts();
  if (name === 'settings') loadSettings();
}
$$('nav button').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
window.addEventListener('hashchange', route);
function route() {
  const [tab, id] = location.hash.slice(1).split('/');
  showTab(tab || 'new');
  if (tab === 'runs' && id) openRun(id);
}

/* ---------- config ---------- */
let state = { config: null, secrets: {} };
async function refreshConfig() {
  state = await api('/config');
  $('#env-select').innerHTML = state.config.environments
    .map((e) => `<option ${e.name === state.config.defaultEnvironment ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  $('#busy').classList.toggle('hidden', !state.busy);
}

/* ---------- new run ---------- */
function readScope() {
  const f = new FormData($('#scope-form'));
  const scope = {
    environment: f.get('environment'),
    jiraKeys: splitList(f.get('jiraKeys')).map((k) => k.toUpperCase()),
    jql: f.get('jql').trim() || undefined,
    tags: splitList(f.get('tags')),
    freeText: f.get('freeText').trim() || undefined,
    includeAlwaysTags: f.get('includeAlwaysTags') === 'on',
  };
  if (f.get('octopusProject') && f.get('octopusRelease')) scope.octopus = { project: f.get('octopusProject').trim(), release: f.get('octopusRelease').trim() };
  return { scope, headed: f.get('headed') === 'on' };
}

$('#preview-btn').addEventListener('click', (e) => busyButton(e.target, async () => {
  const p = await api('/preview', { method: 'POST', body: readScope().scope });
  const el = $('#preview');
  el.classList.remove('hidden');
  el.innerHTML = `<div class="card">
    <h2>${p.selected.length} of ${p.catalogSize} tests selected</h2>
    ${p.scope.issues.length ? `<p><strong>Jira issues:</strong> ${p.scope.issues.map((i) => `${esc(i.key)} ${esc(i.summary)}`).join(' · ')}</p>` : ''}
    ${p.scope.release ? `<p><strong>Release:</strong> ${esc(p.scope.release.projectName)} ${esc(p.scope.release.version)}</p>` : ''}
    ${p.scope.tags.length ? `<p><strong>Tags:</strong> ${esc(p.scope.tags.join(' '))}</p>` : ''}
    ${p.uncoveredIssues.length ? `<p class="b failed">No tests linked to: ${esc(p.uncoveredIssues.join(', '))}</p> <a href="#drafts">Draft tests for them</a>` : ''}
    ${p.scope.notes.length ? `<ul class="notes">${p.scope.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <table><thead><tr><th>Test</th><th>Why</th></tr></thead><tbody>
    ${p.selected.map((t) => `<tr><td>${esc(t.titlePath.join(' › '))}<div class="muted">${esc(t.file)}</div></td><td>${esc(t.reasons.join('; '))}</td></tr>`).join('')}
    </tbody></table></div>`;
}));

$('#load-releases').addEventListener('click', (e) => busyButton(e.target, async () => {
  const project = $('[name=octopusProject]').value.trim();
  if (!project) throw new Error('Enter the Octopus project first');
  const { releases } = await api(`/octopus/releases?project=${encodeURIComponent(project)}`);
  $('#release-list').innerHTML = releases.map((r) => `<option value="${esc(r.version)}">`).join('');
  toast(`Loaded ${releases.length} releases`);
}));

$('#scope-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busyButton($('#scope-form .primary'), async () => {
    const { scope, headed } = readScope();
    const run = await api('/runs', { method: 'POST', body: { scope, headed } });
    location.hash = `runs/${run.id}`;
  });
});

/* ---------- runs ---------- */
async function loadRuns() {
  const { runs, busy } = await api('/runs');
  $('#busy').classList.toggle('hidden', !busy);
  $('#runs-list').innerHTML = `<h1>Runs</h1><div class="card"><table><thead><tr><th>Started</th><th>Environment</th><th>Scope</th><th>Status</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Flaky</th></tr></thead><tbody>
  ${runs.map((r) => `<tr class="click" data-id="${esc(r.id)}"><td>${esc(new Date(r.createdAt).toLocaleString())}</td><td>${esc(r.environment)}</td>
    <td>${esc(scopeLabel(r.scope))}</td><td>${badge(r.status)}</td><td class="num">${r.totals.passed}</td><td class="num">${r.totals.failed}</td><td class="num">${r.totals.flaky}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No runs yet</td></tr>'}
  </tbody></table></div>`;
  $$('#runs-list tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `runs/${tr.dataset.id}`; }));
}

function scopeLabel(s) {
  if (!s) return '';
  const parts = [];
  if (s.release) parts.push(`${s.release.projectName} ${s.release.version}`);
  if (s.issues?.length) parts.push(s.issues.slice(0, 3).map((i) => i.key).join(', ') + (s.issues.length > 3 ? '…' : ''));
  if (s.input?.tags?.length) parts.push(s.input.tags.join(' '));
  if (s.input?.freeText) parts.push(`“${s.input.freeText.slice(0, 40)}”`);
  return parts.join(' · ');
}

let streamAbort;
async function openRun(id) {
  streamAbort?.abort();
  const { run, log } = await api(`/runs/${id}`);
  const el = $('#run-detail');
  el.classList.remove('hidden');
  const done = ['completed', 'failed', 'cancelled'].includes(run.status);
  const failures = run.results.filter((r) => ['failed', 'timedOut', 'interrupted', 'flaky'].includes(r.outcome));
  el.innerHTML = `<div class="card">
    <h2>Run ${esc(run.id)} ${badge(run.status)} ${!done ? `<button class="danger small" id="cancel-run">Cancel</button>` : ''}</h2>
    <p class="muted">${esc(run.environment)} · ${esc(run.baseUrl)} · ${esc(scopeLabel(run.scope))}</p>
    ${run.error ? `<pre class="b failed">${esc(run.error)}</pre>` : ''}
    <div class="tiles">
      <div class="tile"><div class="n">${run.totals.total}</div><div class="l">Tests</div></div>
      <div class="tile"><div class="n" style="color:var(--pass)">${run.totals.passed}</div><div class="l">Passed</div></div>
      <div class="tile"><div class="n" style="color:var(--fail)">${run.totals.failed}</div><div class="l">Failed</div></div>
      <div class="tile"><div class="n" style="color:var(--warn)">${run.totals.flaky}</div><div class="l">Flaky</div></div>
      <div class="tile"><div class="n">${run.totals.skipped}</div><div class="l">Skipped</div></div>
    </div>
    ${done ? `<p class="links"><a href="/runs/${esc(run.id)}/" target="_blank">Open full report</a><a href="/runs/${esc(run.id)}/report.pdf" target="_blank">PDF</a><a href="/runs/${esc(run.id)}/playwright-report/index.html" target="_blank">Playwright report (traces)</a><a href="/runs/${esc(run.id)}/junit.xml" target="_blank">JUnit XML</a></p>` : ''}
    ${run.aiSummary ? `<h2>Copilot summary</h2><div class="ai">${esc(run.aiSummary)}</div>` : ''}
  </div>
  ${done && run.status === 'completed' ? publishPanel(run, failures) : ''}
  <div class="card"><h2>Log</h2><pre class="log" id="run-log">${esc(log)}</pre></div>`;
  const logEl = $('#run-log');
  logEl.scrollTop = logEl.scrollHeight;
  $('#cancel-run')?.addEventListener('click', () => api(`/runs/${id}/cancel`, { method: 'POST' }).then(() => toast('Cancelling…')));
  $('#publish-btn')?.addEventListener('click', (e) => busyButton(e.target, async () => {
    const bugTestIds = $$('input[name=bug]:checked').map((c) => c.value);
    const body = { jiraComments: $('#pub-comments')?.checked, octopus: $('#pub-octopus')?.checked, bugTestIds };
    const summary = [body.jiraComments && `comment on ${run.scope.issues.length} Jira issue(s)`, bugTestIds.length && `file or update ${bugTestIds.length} Jira bug(s)`, body.octopus && 'update Octopus'].filter(Boolean).join(', ');
    if (!summary) throw new Error('Nothing selected to publish');
    if (!confirm(`This will ${summary}. Continue?`)) return;
    await api(`/runs/${id}/publish`, { method: 'POST', body });
    toast('Published');
    openRun(id);
  }));
  if (!done) streamRun(id);
}

function publishPanel(run, failures) {
  const p = run.published ?? { jiraComments: [], jiraBugs: [] };
  return `<div class="card"><h2>Publish results</h2>
    <p class="muted">Nothing is sent until you click Publish. Review the failures first: only file bugs for real product defects.</p>
    ${run.scope?.issues.length ? `<label class="check"><input type="checkbox" id="pub-comments" ${p.jiraComments.length ? '' : 'checked'}> Comment on ${run.scope.issues.length} in-scope Jira issue(s) and attach the PDF ${p.jiraComments.length ? `<span class="muted">(already done: ${esc(p.jiraComments.join(', '))})</span>` : ''}</label>` : ''}
    ${run.scope?.release ? `<label class="check"><input type="checkbox" id="pub-octopus" ${p.octopus ? '' : 'checked'}> Record on Octopus release ${esc(run.scope.release.version)} ${p.octopus ? `<span class="muted">(${esc(p.octopus)})</span>` : ''}</label>` : ''}
    ${failures.length ? `<h2 style="margin-top:12px">Failures</h2><table><thead><tr><th>File bug</th><th>Test</th><th>Error / Copilot triage</th></tr></thead><tbody>
      ${failures.map((r) => `<tr><td><input type="checkbox" name="bug" value="${esc(r.id)}" ${r.outcome === 'flaky' ? 'disabled title="Flaky tests passed on retry"' : ''}></td>
        <td>${badge(r.outcome)} ${esc(r.titlePath.join(' › '))}<div class="muted">${esc(r.file)}:${r.line} ${esc(r.issueKeys.join(' '))}</div></td>
        <td><pre>${esc((r.error ?? '').split('\n').slice(0, 6).join('\n'))}</pre>${r.aiAnalysis ? `<div class="ai">${esc(r.aiAnalysis)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>` : ''}
    ${p.jiraBugs.length ? `<p>Bugs: ${esc(p.jiraBugs.join(', '))}</p>` : ''}
    <div class="actions"><button class="primary" id="publish-btn">Publish…</button></div></div>`;
}

async function streamRun(id) {
  streamAbort = new AbortController();
  try {
    const res = await fetch(`/api/runs/${id}/stream`, { signal: streamAbort.signal, headers: { 'X-QA-Token': TOKEN } });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l) continue;
        const msg = JSON.parse(l);
        const logEl = $('#run-log');
        if (msg.log && logEl) {
          const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
          logEl.textContent += msg.log + '\n';
          if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
        if (msg.status && ['completed', 'failed', 'cancelled'].includes(msg.status)) {
          setTimeout(() => { loadRuns(); if (location.hash.endsWith(id)) openRun(id); }, 800);
          $('#busy').classList.add('hidden');
          return;
        }
      }
    }
  } catch { /* aborted */ }
}

/* ---------- drafts ---------- */
async function loadDrafts() {
  const { drafts } = await api('/drafts');
  $('#drafts-list').innerHTML = drafts.map((d) => `<div class="card" data-name="${esc(d.name)}">
    <h2>${esc(d.name)} <span class="muted small">${esc(new Date(d.modified).toLocaleString())}</span></h2>
    <textarea rows="16" spellcheck="false" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(d.content)}</textarea>
    <div class="actions" style="margin-top:8px"><button class="danger" data-act="delete">Delete</button><button class="ghost" data-act="save">Save</button><button class="primary" data-act="promote">Promote to regression suite</button></div>
  </div>`).join('') || '<p class="muted">No drafts.</p>';
  $$('#drafts-list .card').forEach((card) => {
    const name = card.dataset.name;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      busyButton(e.target, async () => {
        if (act === 'save' || act === 'promote') await api(`/drafts/${name}`, { method: 'PUT', body: { content: $('textarea', card).value } });
        if (act === 'promote') { const r = await api(`/drafts/${name}/promote`, { method: 'POST' }); toast(`Moved to tests/${r.file}. Commit it to the repo.`); }
        if (act === 'delete') { if (!confirm(`Delete ${name}?`)) return; await api(`/drafts/${name}`, { method: 'DELETE' }); }
        if (act === 'save') toast('Saved');
        if (act !== 'save') loadDrafts();
      });
    });
  });
}
$('#draft-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  busyButton($('#draft-form .primary'), async () => {
    const { created } = await api('/drafts', { method: 'POST', body: { keys: splitList(f.get('keys')).map((k) => k.toUpperCase()), pageNotes: f.get('pageNotes') } });
    toast(`Drafted ${created.length} test file(s)`);
    loadDrafts();
  });
});

/* ---------- settings ---------- */
const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const set = (obj, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => (o[k] ??= {}), obj)[last] = v; };

function envRow(e = { name: '', baseUrl: '', authMode: 'duende', octopusEnvironment: '' }) {
  const div = document.createElement('div');
  div.className = 'env-row';
  div.innerHTML = `<label>Name <input data-k="name" value="${esc(e.name)}" required></label>
    <label>Base URL <input data-k="baseUrl" value="${esc(e.baseUrl)}" type="url" required></label>
    <label>Sign-in <select data-k="authMode"><option value="duende" ${e.authMode === 'duende' ? 'selected' : ''}>Duende</option><option value="none" ${e.authMode === 'none' ? 'selected' : ''}>None</option></select></label>
    <label>Octopus env <input data-k="octopusEnvironment" value="${esc(e.octopusEnvironment ?? '')}"></label>
    <button type="button" class="ghost" title="Remove">✕</button>`;
  $('button', div).addEventListener('click', () => div.remove());
  return div;
}
$('#add-env').addEventListener('click', () => $('#env-rows').append(envRow()));

async function loadSettings() {
  await refreshConfig();
  const cfg = state.config;
  $('#env-rows').replaceChildren(...cfg.environments.map(envRow));
  $$('#settings-form [name]').forEach((input) => {
    const v = get(cfg, input.name);
    if (input.dataset.type === 'list') input.value = (v ?? []).join(', ');
    else if (input.dataset.type === 'map') input.value = Object.entries(v ?? {}).map(([k, t]) => `${k}=${t}`).join('\n');
    else input.value = v ?? '';
  });
  $$('.secret').forEach((el) => {
    const name = el.dataset.secret;
    const isSet = state.secrets[name];
    el.innerHTML = `<input type="password" autocomplete="new-password" placeholder="${isSet ? '•••••••• (saved)' : 'not set'}"><button type="button" class="ghost small">Save</button><span class="state ${isSet ? 'set' : 'unset'}">${isSet ? '✓ set' : 'not set'}</span>`;
    $('button', el).onclick = (e) => busyButton(e.target, async () => {
      const input = $('input', el);
      if (!input.value && !confirm('Clear this secret?')) return;
      await api(`/secrets/${name}`, { method: 'PUT', body: { value: input.value } });
      input.value = '';
      toast('Saved to the credential store');
      loadSettings();
    });
  });
}

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busyButton($('#settings-form .primary'), async () => {
    const cfg = structuredClone(state.config);
    cfg.environments = $$('#env-rows .env-row').map((row) => Object.fromEntries($$('[data-k]', row).map((i) => [i.dataset.k, i.value.trim()])));
    $$('#settings-form [name]').forEach((input) => {
      let v = input.value.trim();
      if (input.dataset.type === 'list') v = splitList(v);
      else if (input.dataset.type === 'map') v = Object.fromEntries(v.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([k, t]) => k && t));
      else if (input.type === 'number') v = Number(v);
      set(cfg, input.name, v);
    });
    await api('/config', { method: 'PUT', body: cfg });
    toast('Settings saved');
    loadSettings();
  });
});

$$('[data-test]').forEach((b) => b.addEventListener('click', (e) => busyButton(e.target, async () => {
  const r = await api(`/test-connection/${b.dataset.test}`, { method: 'POST' });
  toast(r.message);
})));

refreshConfig().then(route).catch((e) => toast(e.message, true));
