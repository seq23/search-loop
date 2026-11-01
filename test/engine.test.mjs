import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from '../bin/search-loop.mjs';
import { FIXTURE_CONFIG_RAW, fixtureDraft } from '../src/fixture.mjs';
import { selfTest } from '../src/self-test.mjs';
import { checkReport, REPORT_FIELDS } from '../src/report.mjs';
import { lowest, resolveMode, MODE_RULES } from '../src/mode.mjs';
import { scoreCandidate, claimedElsewhere } from '../src/find.mjs';
import { withRelatedLink, withoutRelatedLink } from '../src/render.mjs';
import { loadRouting } from '../src/llm.mjs';
import { dueCheckpoints } from '../src/check.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
process.env.GSC_SITE_URL = 'sc-domain:example.com';
process.env.OPENROUTER_API_KEY = 'test-key';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.BING_WEBMASTER_API_KEY;

const filler = (n) => `<p>${'Planning is a habit you build one week at a time with a short review. '.repeat(n)}</p>`;
function site({ cfg = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w('index.html', '<html><head><title>Example Planner — plan your week</title></head><body><nav><a href="/download">Get it</a><a href="/weekly-planning/">Weekly planning</a></nav><main><h1>Example Planner</h1></main></body></html>');
  w('weekly-planning/index.html', `<html><head><title>Weekly planning for founders — Example Planner</title></head><body><main><article><h1>Weekly planning for founders</h1>${filler(20)}</article></main></body></html>`);
  w('weekly-review/index.html', `<html><head><title>How to run a weekly review — Example Planner</title></head><body><main><article><h1>How to run a weekly review for your planning</h1>${filler(20)}</article></main></body></html>`);
  w('download.html', '<html><head><title>Download — Example Planner</title></head><body><main><h1>Download weekly planning kit</h1><a href="https://buy.example.com">Buy</a></main></body></html>');
  w('search-loop.config.json', JSON.stringify({ ...FIXTURE_CONFIG_RAW, ...cfg }));
  return root;
}

// One fake internet: Google token + Search Console + autocomplete + sources + live pages + IndexNow.
function fakeFetch({ gscRows = [], pageRows = [], inspectIndexed = true, live = true, calls = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/searchAnalytics/query')) {
      const body = JSON.parse(init.body);
      return json(200, { rows: body.dimensions[0] === 'page' ? pageRows : body.dimensions.length === 1 ? [{ keys: ['plan week founder'], clicks: 0, impressions: 5, position: 14 }] : gscRows });
    }
    if (u.includes('urlInspection')) return json(200, { inspectionResult: { indexStatusResult: { verdict: inspectIndexed ? 'PASS' : 'NEUTRAL', coverageState: 'x' } } });
    if (u.includes('suggestqueries.google.com')) { const q = new URL(u).searchParams.get('q'); return json(200, [q, [`${q} for founders`, `${q} template`]]); }
    if (u.includes('api.bing.com/osjson')) { const q = new URL(u).searchParams.get('query'); return json(200, [q, [`${q} for founders`]]); }
    if (u.includes('raw.githubusercontent.com')) return json(404, {});
    if (u.includes('wikipedia.org')) return new Response('<html>' + 'x'.repeat(1000) + '</html>', { status: 200 });
    if (u.includes('indexnow')) return new Response('', { status: 202 });
    if (u.startsWith('https://example.com/')) return new Response('ok', { status: live ? 200 : 404 });
    return new Response('nope', { status: 404 });
  };
}

const goodChat = (calls = []) => async ({ messages }) => {
  calls.push(messages);
  const q = (messages[1].content.match(/Search to answer: "([^"]+)"/) || [])[1] || 'weekly planning';
  const d = fixtureDraft();
  const cap = q.charAt(0).toUpperCase() + q.slice(1);
  d.h1 = cap.length > 28 ? cap : `${cap}: a simple guide`;
  d.title_lead = cap.slice(0, 44);
  // make each page distinct enough to pass the near-duplicate check
  d.sections = d.sections.map((s, i) => ({ heading: `${s.heading} (${q})`, paragraphs: s.paragraphs.map((p) => `${p} This part is about ${q} and step ${i} of ${q.split(' ').reverse().join(' ')}.`.replace(/Weekly planning works/, `${cap} works`)) }));
  delete d.facts[0].verified;
  return { ok: true, answer: '```json\n' + JSON.stringify(d) + '\n```' };
};

const NOW = new Date('2026-11-02T15:00:00Z');

test('self-test passes and catches every broken shape', async () => {
  assert.match(await selfTest(), /SELF-TEST OK — \d+ broken shapes caught/);
});

test('full run: FIND writes targets, BUILD publishes gated pages, links them, REPORT is valid', async () => {
  const root = site();
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: [{ keys: ['how to plan my week as a founder', 'https://example.com/weekly-planning/'], clicks: 0, impressions: 40, position: 12 }] }), chat: goodChat() });
  assert.ok(r.did.find.targets > 0, 'targets found');
  assert.ok(r.did.build.published > 0, `published: ${r.report.notes.join(' | ')}`);
  assert.ok(r.did.build.published <= 10);
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages;
  for (const p of pages) assert.ok(fs.existsSync(path.join(root, p.rel)), p.rel);
  assert.deepEqual(checkReport(r.report), []);
  for (const f of REPORT_FIELDS) assert.ok(f in r.report, f);
  assert.equal(r.report.published, pages.length);
  assert.equal(r.report.conversions.startsWith('not read: '), true);
  // protected download page is never edited
  assert.ok(!fs.readFileSync(path.join(root, 'download.html'), 'utf8').includes('search-loop'));
  // at least one existing page now links to a new page (no orphans)
  const linked = pages.flatMap((p) => p.linked_from);
  assert.ok(linked.length > 0, 'related links inserted');
  assert.ok(fs.readFileSync(path.join(root, linked[0].rel), 'utf8').includes('<!-- search-loop:related -->'));
  // receipt counts every host and states cost 0
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/discovery-receipt.json')));
  assert.equal(rec.cost_usd, 0);
  assert.ok(rec.hosts['suggestqueries.google.com'].calls > 0);
  assert.match(rec.sources.bing_webmaster, /^not read: /);
  // second run the same day publishes nothing more than the quota
  const r2 = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.equal(r2.did.build.published, 0);
});

test('menu pages are not edited when menu_pages_need_approval is true', async () => {
  const root = site({ cfg: { menu_pages_need_approval: true } });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages;
  assert.ok(r.did.build.published > 0);
  assert.ok(!pages.flatMap((p) => p.linked_from).some((l) => l.route === '/weekly-planning/'), 'menu page untouched');
});

test('mode off: no FIND, no BUILD, CHECK + report still run and say so', async () => {
  const root = site();
  const calls = [];
  const r = await run({ root, now: NOW, 'global-mode': 'off', fetchImpl: fakeFetch(), chat: goodChat(calls) });
  assert.equal(r.did.find, null);
  assert.equal(r.did.build.published, 0);
  assert.equal(calls.length, 0, 'no model call in off');
  assert.equal(r.report.state, 'off');
  assert.ok(r.report.notes.includes('Search loop is switched off (mode=off)'));
  assert.equal(r.report.pace, 0);
});

test('mode slow: at most 3 pages a day; a site config can lower but never raise', async () => {
  const root = site();
  const r = await run({ root, now: NOW, 'global-mode': 'slow', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.ok(r.did.build.published <= 3 && r.did.build.published > 0);
  assert.equal(r.report.state, 'slow');
  const m = await resolveMode({ globalMode: 'slow', siteMode: 'normal' });
  assert.equal(m.mode, 'slow');
  const m2 = await resolveMode({ globalMode: 'normal', siteMode: 'off' });
  assert.equal(m2.mode, 'off');
  assert.equal(lowest('off', 'slow', 'normal'), 'off');
});

test('unreadable global switch fails to slow, never normal', async () => {
  const m = await resolveMode({ fetchImpl: async () => new Response('x', { status: 500 }) });
  assert.equal(m.mode, 'slow');
  assert.match(m.notes.join(' '), /MODE_UNREAD/);
});

test('rate-limited free model drops the day to slow with a named note', async () => {
  const root = site();
  const limited = async () => ({ ok: false, stop: 'NO_FREE_MODEL', rateLimited: true, reason: 'all 429' });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: limited });
  assert.equal(r.mode, 'slow');
  assert.match(r.report.notes.join('\n'), /NAMED NOTE \[FREE_MODEL_RATE_LIMITED\]/);
  assert.equal(r.report.state, 'slow');
});

test('missing model key is a named stop line; CHECK and report still run', async () => {
  const root = site();
  const none = async () => ({ ok: false, stop: 'FREE_MODEL_KEY_MISSING', reason: 'OPENROUTER_API_KEY is not set' });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: none });
  assert.match(r.report.notes.join('\n'), /NAMED STOP \[FREE_MODEL_KEY_MISSING\]/);
  assert.equal(r.report.state, 'stopped');
});

test('a draft that keeps failing the gate is dropped, never published', async () => {
  const root = site();
  const thin = async () => { const d = fixtureDraft(); d.sections = d.sections.slice(0, 1); return { ok: true, answer: JSON.stringify(d) }; };
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: thin });
  assert.equal(r.did.build.published, 0);
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  assert.ok(book.dropped.length > 0);
  assert.match(JSON.stringify(book.dropped[0].reason), /b9/);
});

test('CHECK: 2/4/8-week checkpoints, strengthen near page 1, undo when worse, merge at 90 days', async () => {
  const root = site();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  const L = path.join(root, 'data/search-loop/pages.json');
  const book = JSON.parse(fs.readFileSync(L));
  const p = book.pages[0];
  assert.deepEqual(dueCheckpoints(p, '2026-11-20'), ['w2']);
  // 4 weeks later at position 14 -> strengthened, with a before hash and snapshot
  const d28 = new Date('2026-11-30T15:00:00Z');
  const r = await run({ root, now: d28, 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 14 })) }), chat: goodChat() });
  assert.ok(r.did.check.checked > 0);
  const after = JSON.parse(fs.readFileSync(L)).pages[0];
  assert.ok(after.checks.w2 && after.checks.w4, 'w2 and w4 recorded');
  assert.ok(after.strengthen?.before_hash, `strengthened: ${r.report.notes.join(' | ')}`);
  assert.ok(fs.existsSync(path.join(root, 'data/search-loop/snapshots', after.strengthen.before_hash + '.html')));
  // 14 days later it is worse -> automatic undo restores the before bytes
  const d42 = new Date('2026-12-14T15:00:00Z');
  const r2 = await run({ root, now: d42, 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 25 })) }), chat: goodChat() });
  assert.ok(r2.did.check.undone >= 1);
  const restored = fs.readFileSync(path.join(root, after.rel), 'utf8');
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), after.strengthen.before_hash);
  // 90 days with no impressions -> merged with a 301 and a consolidation ledger
  const d95 = new Date('2027-02-05T15:00:00Z');
  const r3 = await run({ root, now: d95, 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: [] }), chat: goodChat() });
  assert.ok(r3.did.check.merged >= 1);
  const cons = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/consolidation-ledger.json')));
  assert.ok(cons.merges.length >= 1);
  assert.match(fs.readFileSync(path.join(root, '_redirects'), 'utf8'), / 301\n/);
  assert.ok(!fs.existsSync(path.join(root, cons.merges[0].from.replace(/^\//, ''), 'index.html')));
});

test('pace grows when most pages are indexed, halves when they are not, logs why', async () => {
  const root = site();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  const d16 = new Date('2026-11-18T15:00:00Z');
  await run({ root, now: d16, 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ inspectIndexed: true }), chat: goodChat() });
  let pace = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pace.json')));
  assert.equal(pace.per_day, 15);
  assert.match(pace.history.at(-1).reason, /indexed/);
  const root2 = site();
  await run({ root: root2, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  await run({ root: root2, now: d16, 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ inspectIndexed: false }), chat: goodChat() });
  pace = JSON.parse(fs.readFileSync(path.join(root2, 'data/search-loop/pace.json')));
  assert.equal(pace.per_day, 5);
  assert.match(pace.history.at(-1).reason, /halved/);
});

test('scoring and shared-audience dedupe', () => {
  assert.ok(scoreCandidate({ gsc_position: 9, gsc_impressions: 100 }) > scoreCandidate({ gsc_position: 29, gsc_impressions: 100 }));
  assert.ok(scoreCandidate({ google_suggest: true, bing_suggest: true }) > scoreCandidate({ google_suggest: true }));
  const cfg = { site: 'b.com' };
  assert.ok(claimedElsewhere('plan my week', cfg, [{ site: 'z.com', query: 'plan my week', published: true }]));
  assert.ok(claimedElsewhere('plan my week', cfg, [{ site: 'a.com', query: 'my week plan', published: false }]));
  assert.ok(!claimedElsewhere('plan my week', cfg, [{ site: 'z.com', query: 'plan my week', published: false }]));
});

test('related block insert/remove is idempotent and bounded', () => {
  const html = '<html><body><main><article><h1>x</h1></article></main></body></html>';
  const a = withRelatedLink(html, { route: '/q/a/', anchor: 'A' });
  assert.equal(withRelatedLink(a, { route: '/q/a/', anchor: 'A' }), a);
  const b = withRelatedLink(a, { route: '/q/b/', anchor: 'B' });
  assert.equal((b.match(/<li>/g) || []).length, 2);
  assert.equal(withoutRelatedLink(withoutRelatedLink(b, '/q/a/'), '/q/b/'), html);
});

test('free route is $0 only', () => {
  const r = loadRouting({ root: '.', llm: {} });
  assert.ok(r.models.length >= 1);
  assert.ok(r.models.every((m) => m.endsWith(':free')));
  assert.ok(!r.models.includes('nvidia/nemotron-3-super-120b-a12b:free'), 'dead ids never routed');
  assert.ok(r.github.length >= 1 && r.workers.daily_neuron_cap <= 1000);
  assert.equal(MODE_RULES.off.build, false);
});

test('FIND clusters same-intent variants and the free-model screen drops off-audience searches', async () => {
  const { intentKey, relevant, relevanceScreen } = await import('../src/find.mjs');
  assert.equal(intentKey('how to overcome decision fatigue'), intentKey('how to avoid decision fatigue'));
  assert.equal(intentKey('how to stop decision fatigue'), intentKey('decision fatigue'));
  assert.notEqual(intentKey('decision fatigue adhd'), intentKey('decision fatigue'));
  const cfg = { ...FIXTURE_CONFIG_RAW, topics: ['weekly review'], audience: 'founders' };
  assert.equal(relevant('is us weekly reliable', cfg), false);
  assert.equal(relevant('weekly review template', cfg), true);
  const list = [{ query: 'weekly review template' }, { query: 'publishers weekly review' }];
  const chat = async () => ({ ok: true, answer: '{"keep":[0]}' });
  const r = await relevanceScreen(cfg, list, { chat });
  assert.deepEqual([...r.keep].map((x) => x.query), ['weekly review template']);
  const down = await relevanceScreen(cfg, list, { chat: async () => ({ ok: false, reason: '429' }) });
  assert.match(down.notRead, /429/);
});

test('a draft the model marks off-audience is dropped with the reason', async () => {
  const root = site();
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: async () => ({ ok: true, answer: '{"skip":"different meaning"}' }) });
  assert.equal(r.did.build.published, 0);
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  assert.match(JSON.stringify(book.dropped), /off-audience/);
});

test('meta descriptions over 160 characters are cut at a word boundary, never padded', async () => {
  const { fitMeta } = await import('../src/build.mjs');
  const long = 'Plan your week by choosing three outcomes, blocking time for each one on the calendar, and reviewing honestly on Friday afternoon so that next week starts from the truth.';
  const m = fitMeta(long);
  assert.ok(m.length >= 120 && m.length <= 160, String(m.length));
  assert.equal(fitMeta('short one'), 'short one');
});

test('a model that never answers leaves the search queued (not dropped); BUILD with no targets runs FIND first', async () => {
  const root = site();
  const down = async () => ({ ok: false, stop: 'NO_FREE_MODEL', rateLimited: false, reason: 'all empty' });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: down });
  assert.ok(r.did.find && r.did.find.targets > 0, 'build stage ran FIND because no targets existed');
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  assert.equal(book.dropped.length, 0);
  assert.ok(r.did.build.model_failed >= 1);
});

test('free lanes: GitHub Models -> OpenRouter -> metered Workers AI, backoff across lanes, $0 only', async () => {
  const { freeChat, resetLanes, laneState, worstNeurons } = await import('../src/llm.mjs');
  const cfg = { root: '.', llm: {} };
  const msgs = [{ role: 'user', content: 'x'.repeat(3000) }];
  const J = (status, body, h = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });
  const env = (o) => { for (const k of ['GITHUB_MODELS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) { if (o[k] === undefined) delete process.env[k]; else process.env[k] = o[k]; } };
  const noSleep = async () => {};

  // 1. GitHub Models answers first.
  resetLanes(); env({ GITHUB_MODELS_TOKEN: 't' });
  let r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async (u) => (String(u).includes('models.github.ai') ? J(200, { choices: [{ message: { content: 'gh answer' } }] }) : J(500, {})) });
  assert.equal(r.ok, true); assert.match(r.model, /^github:/);

  // 2. GitHub 429 (daily: retry-after > 1h) -> OpenRouter daily quota -> Workers AI within its metered share.
  resetLanes(); env({ GITHUB_MODELS_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'c' });
  const calls = [];
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async (u, init) => {
    const s = String(u); calls.push(s);
    if (s.includes('models.github.ai')) return J(429, {}, { 'retry-after': '86400' });
    if (s.includes('openrouter.ai')) return J(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
    if (s.endsWith('/graphql')) return J(200, { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 100 }, dimensions: { modelId: '@cf/google/gemma-3-12b-it' } }, { sum: { totalNeurons: 5000 }, dimensions: { modelId: '@cf/mistralai/mistral-small-3.1-24b-instruct' } }] }] } } });
    if (s.includes('/ai/run/')) return J(200, { result: { response: 'workers answer' } });
    return J(500, {});
  } });
  assert.equal(r.ok, true); assert.match(r.model, /^workers:/);
  assert.match(laneState.closed.openrouter, /free-models-per-day/);
  assert.equal(calls.filter((c) => c.includes('openrouter.ai')).length, 1, 'a used-up daily quota closes the lane at once');

  // 3. Workers AI fails CLOSED when today's usage cannot be read, and when the share is used.
  resetLanes(); env({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'c' });
  let ran = 0;
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: async (u) => { if (String(u).includes('/ai/run/')) ran++; return String(u).endsWith('/graphql') ? J(200, { errors: [{ message: 'not authorized' }] }) : J(500, {}); } });
  assert.equal(r.ok, false); assert.equal(ran, 0, 'no Workers AI call without a usage reading'); assert.match(laneState.closed.workers, /fails closed/);
  resetLanes();
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: async (u) => { if (String(u).includes('/ai/run/')) ran++; return J(200, { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 590 }, dimensions: { modelId: '@cf/google/gemma-3-12b-it' } }] }] } } }); } });
  assert.equal(ran, 0, 'share used -> no call'); assert.match(laneState.closed.workers, /share/);
  assert.ok(worstNeurons({ neurons_per_m_input: 31400, neurons_per_m_output: 50600 }, msgs, 3500) > 177);

  // 4. Per-minute 429 everywhere -> back off, then succeed on the next round.
  resetLanes(); env({ GITHUB_MODELS_TOKEN: 't' });
  let n = 0; const waits = [];
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: async (ms) => waits.push(ms), fetchImpl: async (u) => { if (String(u).includes('models.github.ai')) { n++; return n <= 3 ? J(429, {}, { 'retry-after': '20' }) : J(200, { choices: [{ message: { content: 'after backoff' } }] }); } return J(429, {}, { 'retry-after': '20' }); } });
  assert.equal(r.ok, true); assert.ok(waits.length >= 1, 'backed off before retrying');

  // 5. Every lane out -> NO_FREE_MODEL, rate-limited (BUILD drops to slow and requeues).
  resetLanes(); env({ GITHUB_MODELS_TOKEN: 't' });
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async () => J(429, { error: { message: 'free-models-per-day' } }, { 'retry-after': '90000' }) });
  assert.equal(r.ok, false); assert.equal(r.stop, 'NO_FREE_MODEL'); assert.equal(r.rateLimited, true);

  // 6. A non-zero cost fails loud.
  resetLanes(); env({});
  await assert.rejects(freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async () => J(200, { usage: { cost: 0.01 }, choices: [{ message: { content: 'x' } }] }) }), /FAIL_LOUD/);
  env({});
});

test('stagger spreads sites across 0-39 minutes, deterministically', async () => {
  const { staggerMinutes } = await import('../bin/search-loop.mjs');
  const s = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'].map(staggerMinutes);
  assert.ok(s.every((m) => m >= 0 && m < 40));
  assert.ok(new Set(s).size >= 4);
  assert.equal(staggerMinutes('a.com'), staggerMinutes('a.com'));
});
