#!/usr/bin/env node
// Engine contract validator. Reads the REAL files it governs; --self-test
// mutates those same sources with .replace() and proves each break is caught.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_FIELDS, STATES, REPORT_SCHEMA } from '../src/report.mjs';
import { DEFAULTS, checkConfig } from '../src/config.mjs';
import { MODES, OFF_SENTENCE } from '../src/mode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export function sources() {
  return {
    schema: read('schema/search-loop-week-v1.json'),
    reusable: read('.github/workflows/search-loop.yml'),
    modeSync: read('.github/workflows/mode-sync.yml'),
    modeFile: read('control/mode.json'),
    readme: read('README.md'),
    routing: read('config/free-models.json'),
    example: read('examples/search-loop.config.json'),
    referrers: read('config/ai_referrers.json'),
    files: listFiles(),
  };
}

function listFiles() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { if (['.git', 'node_modules'].includes(e.name)) continue; const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else out.push(r); } };
  walk('.');
  return out.map((f) => ({ path: f, text: /\.(mjs|js|json|yml|md)$/.test(f) ? read(f) : '' }));
}

export function check(s) {
  const p = [];
  let examined = 0;
  // 1. The report schema Boss OS reads: name and fields exactly.
  const sch = JSON.parse(s.schema); examined++;
  if (sch.title !== REPORT_SCHEMA || sch.properties?.schema?.const !== REPORT_SCHEMA) p.push(`schema file must be titled and pinned ${REPORT_SCHEMA}`);
  const req = new Set(sch.required || []);
  for (const f of REPORT_FIELDS) if (!req.has(f)) p.push(`schema does not require ${f}`);
  if (JSON.stringify(sch.properties?.state?.enum) !== JSON.stringify(STATES)) p.push('schema state enum differs from the engine');
  // 2. Reusable workflow: callable, uploads search-loop-week always, publishes only on the default branch.
  const w = s.reusable; examined++;
  if (!/^\s{2}workflow_call:/m.test(w)) p.push('search-loop.yml is not a reusable workflow (workflow_call)');
  if (!/name:\s*search-loop-week\b/.test(w)) p.push('search-loop.yml does not upload the artifact "search-loop-week"');
  const up = w.slice(w.indexOf('Upload the weekly report'), w.indexOf('name: search-loop-week'));
  if (!/if:\s*always\(\)/.test(up)) p.push('the search-loop-week upload must run if: always()');
  if (!w.includes("github.ref_name == github.event.repository.default_branch")) p.push('publishing must be limited to the default branch');
  if (!/bin\/search-loop\.mjs run/.test(w)) p.push('search-loop.yml never runs the engine');
  if (!/repository:\s*seq23\/search-loop/.test(w)) p.push('search-loop.yml must check out the engine from seq23/search-loop');
  if (/confirm_paid|ANTHROPIC_API_KEY|OPENAI_API_KEY/.test(w)) p.push('search-loop.yml references a paid lane or key');
  // 3. The global switch.
  examined++;
  if (!/vars\.SEARCH_LOOP_MODE/.test(s.modeSync)) p.push('mode-sync.yml does not read vars.SEARCH_LOOP_MODE');
  if (!/control\/mode\.json/.test(s.modeSync)) p.push('mode-sync.yml does not write control/mode.json');
  if (!/schedule:/.test(s.modeSync)) p.push('mode-sync.yml has no schedule');
  const mf = JSON.parse(s.modeFile);
  if (!MODES.includes(mf.mode)) p.push(`control/mode.json mode "${mf.mode}" is not ${MODES.join('|')}`);
  // 4. README documents the switch, the off sentence and every config key.
  examined++;
  if (!s.readme.includes('gh variable set SEARCH_LOOP_MODE --body slow -R seq23/search-loop')) p.push('README lacks the one-line switch command');
  if (!s.readme.includes(OFF_SENTENCE)) p.push('README does not quote the off sentence');
  if (!s.readme.includes('search-loop-week-v1')) p.push('README does not name the report schema');
  for (const k of [...Object.keys(DEFAULTS), 'schema', 'site', 'base_url', 'site_name', 'site_words', 'audience', 'voice', 'topics', 'action', 'allowed_link_targets', 'output', 'template', 'publisher', 'indexnow', 'gsc']) {
    if (!new RegExp('`' + k + '[`.\\[]').test(s.readme)) p.push(`README does not document config key ${k}`);
  }
  // 5. $0 routing.
  const r = JSON.parse(s.routing); examined++;
  if (r.policy?.max_cost_usd !== 0 || r.policy?.fallback_to_paid !== false) p.push('config/free-models.json must be max_cost_usd 0 and fallback_to_paid false');
  if (!(r.free_models || []).length || r.free_models.some((m) => String(m.pricing?.prompt) !== '0' || String(m.pricing?.completion) !== '0' || !String(m.id).endsWith(':free'))) p.push('every routed model must be :free and priced 0/0');
  // 6. Example config is valid.
  examined++;
  const ex = checkConfig(JSON.parse(s.example));
  if (ex.length) p.push(`examples/search-loop.config.json invalid: ${ex.join('; ')}`);
  // 7. Privacy: AI referrers match hostnames only.
  examined++;
  const ref = JSON.parse(s.referrers);
  if (Object.keys(ref.engines || {}).some((h) => h.includes('/') || h.includes('?'))) p.push('ai_referrers.json must list hostnames only');
  // 8. Nothing confidential or secret in a public repo.
  for (const f of s.files) {
    examined++;
    if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(f.text) && !f.path.includes('test')) p.push(`${f.path}: contains a private key`);
    if (/\bsk-or-v1-[a-f0-9]{20,}|\bsk-ant-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9]{30,}/.test(f.text)) p.push(`${f.path}: contains an API token`);
    const emails = (f.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) || []).filter((e) => !/noreply|example\.(com|org)|iam\.gserviceaccount\.com$/.test(e));
    if (emails.length) p.push(`${f.path}: contains an email address (${emails[0]})`);
    if (f.text.split('\n').some((l) => /west peek/i.test(l) && !/exclude_words|west peek\/i/.test(l))) p.push(`${f.path}: names West Peek outside an exclude list (Spry never names it)`);
  }
  if (examined < 10) p.push(`examined only ${examined} items (floor 10) — the validator saw nothing`);
  return { problems: p, examined };
}

function selfTest() {
  const real = sources();
  const mut = (k, a, b) => () => { const s = { ...real, [k]: real[k].replace(a, b) }; if (s[k] === real[k]) return { problems: ['MUTATION DID NOT APPLY'] }; return check(s); };
  const BROKEN = [
    ['schema loses ai_bot_hits', mut('schema', '"ai_bot_hits",', '')],
    ['schema renamed', mut('schema', '"title": "search-loop-week-v1"', '"title": "search-loop-week-v2"')],
    ['artifact renamed', mut('reusable', 'name: search-loop-week\n', 'name: search-loop-report\n')],
    ['upload not always()', mut('reusable', /(Upload the weekly report\n\s+)if: always\(\)/, '$1if: success()')],
    ['publishes from any branch', mut('reusable', "github.ref_name == github.event.repository.default_branch", 'true')],
    ['not reusable', mut('reusable', '  workflow_call:', '  workflow_dispatch:')],
    ['paid lane added', mut('reusable', 'INDEXNOW_KEY: ${{ secrets.INDEXNOW_KEY }}', 'INDEXNOW_KEY: ${{ secrets.INDEXNOW_KEY }}\n      ANTHROPIC_API_KEY: x')],
    ['switch not read', mut('modeSync', /vars\.SEARCH_LOOP_MODE/g, 'vars.OTHER')],
    ['mode file unknown mode', mut('modeFile', '"mode": "normal"', '"mode": "turbo"')],
    ['README loses switch command', mut('readme', 'gh variable set SEARCH_LOOP_MODE --body slow -R seq23/search-loop', 'gh variable set X')],
    ['README loses a config key', mut('readme', '| `shares_audience_with[]` |', '| shares |')],
    ['paid model routed', mut('routing', '"completion": "0"', '"completion": "0.000001"')],
    ['paid fallback on', mut('routing', '"fallback_to_paid": false', '"fallback_to_paid": true')],
    ['example config broken', mut('example', '"site_name": "Spry Executive OS",', '')],
    ['referrer list keeps paths', mut('referrers', '"chatgpt.com":', '"chatgpt.com/c/":')],
    ['token leaked', () => check({ ...real, files: [...real.files, { path: 'x.mjs', text: `const k = "${'sk-or-' + 'v1-'}0123456789abcdef0123456789abcdef";` }] })],
    ['email leaked', () => check({ ...real, files: [...real.files, { path: 'x.md', text: `write to someone${'@'}gmail.com` }] })],
    ['saw nothing', () => check({ ...real, files: [] })],
  ];
  const missed = BROKEN.filter(([, f]) => f().problems.length === 0 || f().problems[0] === 'MUTATION DID NOT APPLY').map(([n]) => n);
  if (missed.length) { console.error(`NAMED STOP [SELF_TEST_BLIND] not caught: ${missed.join(', ')}`); process.exit(1); }
  console.log(`SELF-TEST OK — ${BROKEN.length} broken shapes caught`);
}

if (process.argv.includes('--self-test')) selfTest();
else {
  const { problems, examined } = check(sources());
  if (problems.length) { for (const x of problems) console.error(`FAIL ${x}`); console.error(`NAMED STOP [ENGINE_CONTRACT] ${problems.length} problem(s)`); process.exit(1); }
  console.log(`validate: OK — ${examined} items examined`);
}
