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
import { isoWeek } from '../src/util.mjs';
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
function fakeFetch({ gscRows = [], pageRows = [], dateRows = [], inspectIndexed = true, live = true, calls = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/searchAnalytics/query')) {
      const body = JSON.parse(init.body);
      return json(200, { rows: body.dimensions[0] === 'date' ? dateRows : body.dimensions[0] === 'page' ? pageRows : body.dimensions.length === 1 ? [{ keys: ['plan week founder'], clicks: 0, impressions: 5, position: 14 }] : gscRows });
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
  // a different answer per search (the distinct gate compares answers too)
  const vocab = 'calendar outcome review morning block focus habit notebook energy meeting inbox priority deadline client launch budget hiring sprint retro goal metric team weekend travel sleep coffee walk call email draft invoice roadmap pitch investor demo feedback lesson routine checklist template sunday friday quarter month season'.split(' ');
  const h = crypto.createHash('sha256').update(q).digest();
  const words = vocab.map((w, i) => [h[i % 32] * 64 + i, w]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 40);
  d.direct_answer = `${cap} is ${words.join(' ')}.`;
  // make each page distinct enough to pass the near-duplicate check
  d.sections = d.sections.map((s, i) => ({ ...s, heading: `${s.heading} (${q})`, paragraphs: s.paragraphs.map((p) => `${p} This part is about ${q} and step ${i} of ${q.split(' ').reverse().join(' ')}.`.replace(/Weekly planning works/, `${cap} works`)) }));
  delete d.facts[0].verified; delete d.facts[1].verified;
  return { ok: true, answer: '```json\n' + JSON.stringify(d) + '\n```' };
};

// Pages whose body text is really different per search (goodChat's bodies share
// most sentences, so the near-duplicate gate lets only a few through).
const distinctChat = (calls = []) => async (args) => {
  const d = JSON.parse((await goodChat(calls)(args)).answer.replace(/^```json\n|\n```$/g, ''));
  const q = d.h1;
  const vocab = 'calendar outcome review morning block focus habit notebook energy meeting inbox priority deadline client launch budget hiring sprint retro goal metric team weekend travel sleep coffee walk call email draft invoice roadmap pitch investor demo feedback lesson routine checklist template sunday friday quarter month season'.split(' ');
  const text = (seed) => { const h = crypto.createHash('sha256').update(q + seed).digest(); return Array.from({ length: 130 }, (_, i) => vocab[(h[i % 32] + i * h[(i + 7) % 32]) % vocab.length]).join(' ') + '.'; };
  d.sections = d.sections.map((x, i) => ({ ...x, paragraphs: [text(`a${i}`), text(`b${i}`)] }));
  return { ok: true, answer: JSON.stringify(d) };
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

test('every free lane out is a NOTE the next run retries, never red — however long it lasts; the streak is named; a publish ends it', async () => {
  const limited = async () => ({ ok: false, stop: 'NO_FREE_MODEL', rateLimited: true, reason: 'all 429' });
  const at = (h) => new Date(NOW.getTime() + h * 3600000);
  const streakOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/runs.json'), 'utf8')).no_free_model;
  const root = site();
  // Runs 1-4 over more than 24 h: rate-limited -> slow for the day, nothing published,
  // searches queued -> a named NOTE every time (exit 0), the streak counted and named.
  for (const [i, h] of [[1, 0], [2, 2], [3, 4], [4, 30]]) {
    const r = await run({ root, now: at(h), 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: limited });
    assert.equal(r.mode, 'slow');
    assert.equal(r.report.state, 'slow');
    assert.match(r.report.notes.join('\n'), /NAMED NOTE \[FREE_MODEL_RATE_LIMITED\]/);
    assert.equal(r.did.build.published, 0);
    assert.equal(r.stop, undefined, `run ${i} of the streak carries no stop`);
    assert.doesNotMatch(r.report.notes.join('\n'), /NAMED STOP \[NO_FREE_MODEL\]/);
    assert.match(r.report.notes.join('\n'), new RegExp(`NAMED NOTE \\[NO_FREE_MODEL\\].*run ${i} in a row since`), 'the weekly report carries the note and the streak');
    assert.equal(streakOf(root).runs, i);
    assert.equal(streakOf(root).red, undefined);
  }
  // A run that publishes ends the streak.
  const ok = await run({ root, now: at(50), 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.ok(ok.did.build.published > 0);
  assert.equal(streakOf(root), undefined, 'a publishing run clears the streak');
  assert.doesNotMatch(ok.report.notes.join('\n'), /NO_FREE_MODEL/);
});

test('missing model key (no lane has any credential) is a named stop line; CHECK and report still run', async () => {
  const root = site();
  const none = async () => ({ ok: false, stop: 'FREE_MODEL_KEY_MISSING', reason: 'OPENROUTER_API_KEY is not set' });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: none });
  assert.match(r.report.notes.join('\n'), /NAMED STOP \[FREE_MODEL_KEY_MISSING\]/);
  assert.equal(r.report.state, 'stopped');
});

test('a draft under 75% of a floor keeps failing the gate and is dropped, never published', async () => {
  const root = site();
  // Under 450 words (75% of the 600 aim): thin, dropped.
  const thin = async () => { const d = fixtureDraft(); d.sections = d.sections.slice(0, 1).map((x) => ({ ...x, paragraphs: x.paragraphs.slice(0, 1) })); d.faq = d.faq.slice(0, 3); return { ok: true, answer: JSON.stringify(d) }; };
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

// v1.3.0: the fixed pace (10/day, +5/week, cap 30) is replaced by an
// outcome-gated per-site cap (her ruling, 3 Nov 2026).
const days = (from, n, perDay) => Array.from({ length: n }, (_, i) => ({ keys: [new Date(new Date(from).getTime() + i * 86400000).toISOString().slice(0, 10)], clicks: 0, impressions: perDay, position: 12 }));
// NOW = 2026-11-02: last 28 days = 2026-10-03..2026-10-30, the 28 before = 2026-09-05..2026-10-02.
const window = (prevPerDay, lastPerDay) => [...days('2026-09-05', 28, prevPerDay), ...days('2026-10-03', 28, lastPerDay)];
function seed(root, queries) {
  fs.mkdirSync(path.join(root, 'data/search-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/search-loop/targets.json'), JSON.stringify({ schema: 'search-loop-targets-v1', week: isoWeek(NOW), targets: queries.map((query, i) => ({ query, kind: 'new', score: 50 - i, signals: {} })), strengthen: [] }));
}
const DISTINCT_QUERIES = ['how to pay contractors on time', 'invoice reminders for freelancers', 'hiring your first engineer', 'quarterly board meeting agenda', 'pricing a consulting retainer', 'choosing a payroll provider'];
const capFile = (root) => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/cap.json')));

test('the cap rises only when Google impressions grow, falls when they drop, holds without Search Console data, logs why', async () => {
  const { nextCap } = await import('../src/cap.mjs');
  const cfg = { cap: {} };
  assert.equal(nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 120, prev: 100 }, NOW).cap.max_live_pages, 55);
  assert.equal(nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 80, prev: 100 }, NOW).cap.max_live_pages, 45);
  assert.equal(nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 100, prev: 100 }, NOW).cap.max_live_pages, 50);
  assert.equal(nextCap(cfg, { max_live_pages: 10, history: [] }, { last: 1, prev: 100 }, NOW).cap.max_live_pages, 10, 'never under min_pages');
  const nd = nextCap(cfg, { max_live_pages: 50, history: [] }, { notRead: 'no rows' }, NOW);
  assert.equal(nd.cap.max_live_pages, 50); assert.equal(nd.held, true); assert.match(nd.reason, /no Search Console numbers/);
  // End to end: a fresh site starts at 20 (start_pages); growth -> 22, drop -> 18, no rows -> 20 held with a named note.
  const cases = [[window(10, 20), 22, /^cap: up from 20 to 22/m], [window(20, 10), 18, /^cap: down from 20 to 18/m], [[], 20, /NAMED NOTE \[CAP_HELD_NO_DATA\]/], [window(0, 0).slice(28), 20, /CAP_HELD_NO_DATA.*nothing to compare/]];
  for (const [dateRows, want, note] of cases) {
    const root = site();
    const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ dateRows }), chat: goodChat() });
    const c = capFile(root);
    assert.equal(c.max_live_pages, want);
    assert.match(r.report.notes.join('\n'), note);
    assert.equal(r.report.cap.max_live_pages, want);
    assert.ok(r.report.cap.why.length > 0);
    assert.ok(c.history.length >= 2, 'start and change both logged');
    // once a week: a second run the same week does not move it again
    await run({ root, now: new Date('2026-11-03T15:00:00Z'), 'global-mode': 'normal', fetchImpl: fakeFetch({ dateRows: window(1, 1000) }), chat: goodChat() });
    assert.equal(capFile(root).max_live_pages, want);
  }
});

test('over the cap nothing publishes; under it only the room publishes; held searches are counted', async () => {
  const root = site({ cfg: { cap: { max_live_pages: 2 } } });
  seed(root, DISTINCT_QUERIES);
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: distinctChat() });
  const live = () => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages.filter((p) => p.status === 'live').length;
  assert.equal(live(), 2, 'filled up to the cap and no further');
  assert.ok(r.did.build.held > 0);
  assert.equal(r.report.held_by_cap, r.did.build.held);
  assert.deepEqual(r.report.cap, { ...r.report.cap, max_live_pages: 2, live: 2, room: 0 });
  // next day, at the cap: nothing publishes, the model is never asked
  const calls = [];
  const r2 = await run({ root, now: new Date('2026-11-03T15:00:00Z'), 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: distinctChat(calls) });
  assert.equal(r2.did.build.published, 0);
  assert.equal(calls.filter((m) => /Search to answer/.test(m[1]?.content)).length, 0);
  assert.equal(live(), 2);
  assert.match(r2.report.notes.join('\n'), /BUILD held by the cap: 2 live engine page\(s\), cap 2/);
  assert.ok(r2.report.held_by_cap > r.report.held_by_cap, 'held counts add up over the week');
  // negative proof: the same site with room publishes more than 2
  const open = site({ cfg: { cap: { max_live_pages: 50 } } });
  seed(open, DISTINCT_QUERIES);
  const r3 = await run({ root: open, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: distinctChat() });
  assert.ok(r3.did.build.published > 2, `published ${r3.did.build.published}`);
  assert.equal(r3.did.build.held, 0);
});

test('a same-intent search becomes a strengthen brief for the existing URL, never a new page', async () => {
  const root = site();
  // a page only the sitemap knows about (built elsewhere, not in the checkout)
  fs.writeFileSync(path.join(root, 'sitemap.xml'), '<urlset><url><loc>https://example.com/guides/weekly-budget-template/</loc></url></urlset>');
  seed(root, ['weekly planning for founders template', 'how to run a weekly review for my planning', 'weekly budget template', 'how to pay contractors on time']);
  const calls = [];
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: goodChat(calls) });
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  const by = Object.fromEntries(book.redirected.map((x) => [x.query, x.url]));
  assert.equal(by['weekly planning for founders template'], 'https://example.com/weekly-planning/');
  assert.equal(by['how to run a weekly review for my planning'], 'https://example.com/weekly-review/');
  assert.equal(by['weekly budget template'], 'https://example.com/guides/weekly-budget-template/');
  for (const q of Object.keys(by)) assert.ok(!book.pages.some((p) => p.query === q), `no page for "${q}"`);
  assert.equal(calls.filter((m) => Object.keys(by).some((q) => m[1]?.content.includes(`"${q}"`))).length, 0, 'no model call spent on a same-intent search');
  const t = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/targets.json')));
  assert.ok(t.strengthen.some((x) => x.query === 'weekly planning for founders template' && x.page === '/weekly-planning/' && x.from === 'distinct-gate'));
  assert.ok(r.report.redirected.some((x) => x.query === 'weekly budget template' && x.strengthen === 'https://example.com/guides/weekly-budget-template/'));
  // negative proof: the distinct search still publishes
  assert.ok(book.pages.some((p) => p.query === 'how to pay contractors on time'), 'a distinct search is published');
  // same answer: a second search whose draft repeats an engine page's answer is redirected after drafting
  const root2 = site();
  seed(root2, ['how to pay contractors on time', 'invoice reminders for freelancers']);
  const sameAnswer = async (args) => { const a = JSON.parse((await goodChat()(args)).answer.replace(/^```json\n|\n```$/g, '')); a.direct_answer = fixtureDraft().direct_answer; return { ok: true, answer: JSON.stringify(a) }; };
  await run({ root: root2, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: sameAnswer });
  const b2 = JSON.parse(fs.readFileSync(path.join(root2, 'data/search-loop/pages.json')));
  assert.equal(b2.pages.length, 1);
  assert.match(b2.redirected[0].matched_by, /same answer/);
  assert.equal(b2.redirected[0].url, b2.pages[0].url);
});

test('Horse and Hicks: a published page is never modified, redirected, merged or undone; same-intent searches are skipped', async () => {
  const { publishedFrozen } = await import('../src/config.mjs');
  assert.ok(publishedFrozen({ base_url: 'https://horselegalguide.com' }) && publishedFrozen({ base_url: 'https://www.hicksconsulting.org' }));
  const hashes = (root) => Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter((f) => /\.html$|^_redirects$/.test(f)).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
  const lifecycle = async (frozen) => {
    const root = site({ cfg: frozen ? { published_pages_frozen: true } : {} });
    const existing = hashes(root);
    await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
    const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
    const afterBuild = hashes(root);
    const rows = (pos, imp = 30) => book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: imp, position: pos }));
    await run({ root, now: new Date('2026-11-30T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: rows(14) }), chat: goodChat() });
    await run({ root, now: new Date('2026-12-14T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: rows(25) }), chat: goodChat() });
    await run({ root, now: new Date('2027-02-05T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: [] }), chat: goodChat() });
    return { root, existing, afterBuild, published: book.pages, end: hashes(root), final: JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))) };
  };
  const f = await lifecycle(true);
  assert.ok(f.published.length > 0, 'new pages still publish');
  for (const [file, h] of Object.entries(f.existing)) assert.equal(f.afterBuild[file], h, `existing ${file} edited by BUILD`);
  for (const [file, h] of Object.entries(f.afterBuild)) assert.equal(f.end[file], h, `published ${file} changed by CHECK`);
  assert.ok(!fs.existsSync(path.join(f.root, '_redirects')), 'no redirect written');
  assert.ok(f.final.pages.every((p) => p.status === 'live' && !p.strengthen && p.checks.w2 && p.checks.w8), 'checkpoints recorded, nothing strengthened, undone or merged');
  assert.ok(!(f.final.redirected || []).length, 'no strengthen brief on a frozen site');
  assert.ok(f.final.dropped.some((d) => /skipped, published pages are frozen/.test(d.reason[0])), 'same-intent searches are skipped');
  // negative proof: the same lifecycle on an unfrozen site does touch published pages
  const u = await lifecycle(false);
  assert.ok(Object.entries(u.afterBuild).some(([file, h]) => u.end[file] !== h) || Object.entries(u.existing).some(([file, h]) => u.afterBuild[file] !== h), 'the unfrozen twin changes pages');
  assert.ok(fs.existsSync(path.join(u.root, '_redirects')));
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
  assert.ok(r.gemini.length >= 1 && r.workers.daily_neuron_cap <= 600, 'Workers AI keeps the 600-neuron daily cap');
  assert.equal(r.github, undefined, 'GitHub Models (retired 2026-07-30) is not routed');
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

test('a draft that only misses style or over-limit aims is published, with its notes kept (never dropped)', async () => {
  const root = site();
  const base = goodChat(); // distinct pages per search (near-duplicates still block)
  const styled = async (args) => {
    const d = JSON.parse((await base(args)).answer.replace(/^```json\n|\n```$/g, ''));
    d.title_lead = `${d.title_lead} when everything is on fire and nothing works — Example Planner`;
    d.direct_answer += ' ' + d.direct_answer; // ~100 words, over the 60 aim
    d.faq[0].a += ' ' + d.faq[0].a; // over the 60-word aim
    d.sections = d.sections.slice(0, 3); // a little under 600 words, above 450
    d.sections[0].paragraphs[0] += ' Let us delve into it.';
    return { ok: true, answer: JSON.stringify(d) };
  };
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: styled });
  assert.ok(r.did.build.published > 0, 'style-only misses publish');
  const book0 = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'), 'utf8'));
  // The fixture pages share text, so some are true near-duplicates (a real block); none is dropped for style or length.
  for (const d of book0.dropped) for (const why of d.reason) assert.match(why, /^near-duplicate/, `dropped for a non-blocking reason: ${why}`);
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  const notes = book.pages[0].gate_notes.join('\n');
  for (const re of [/b4 direct answer .* words/, /b5 FAQ answer is \d+ words/, /filler phrase/]) assert.match(notes, re);
  assert.match(r.report.notes.join('\n'), /BUILD gate notes \(not blocking\)/);
  const html = fs.readFileSync(path.join(root, book.pages[0].rel), 'utf8');
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.length <= 65, `title fitted: ${title.length}`);
  assert.equal(title.split('Example Planner').length - 1, 1, 'site name once');
});

test('meta descriptions over 160 characters are cut at a word boundary, never padded', async () => {
  const { fitMeta } = await import('../src/build.mjs');
  const long = 'Plan your week by choosing three outcomes, blocking time for each one on the calendar, and reviewing honestly on Friday afternoon so that next week starts from the truth.';
  const m = fitMeta(long);
  assert.ok(m.length >= 120 && m.length <= 160, String(m.length));
  assert.equal(fitMeta('short one'), 'short one');
  // never ends on a dangling function word ("... for your.") — Hicks' validator blocks those
  const dangling = 'Hicks Consulting helps small nonprofits write grant budgets that funders trust and approve quickly with a clear process built for your team and the board that reviews every line';
  const d = fitMeta(dangling);
  assert.ok(d.length >= 120 && d.length <= 160, String(d.length));
  assert.doesNotMatch(d, /\b(for|your|the|a|an|of|to|and|or|with|that|in|on)\.$/i, d);
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

test('free lanes: Gemini -> OpenRouter -> metered Workers AI, backoff across lanes, $0 only', async () => {
  const { freeChat, resetLanes, laneState, worstNeurons } = await import('../src/llm.mjs');
  const cfg = { root: '.', llm: {} };
  const msgs = [{ role: 'user', content: 'x'.repeat(3000) }];
  const J = (status, body, h = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });
  const env = (o) => { for (const k of ['GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_WORKERS_AI_TOKEN']) { if (o[k] === undefined) delete process.env[k]; else process.env[k] = o[k]; } };
  const noSleep = async () => {};

  // 1. Gemini answers first; the retired GitHub Models endpoint is never asked.
  resetLanes(); env({ GEMINI_API_KEY: 'g' });
  const asked1 = [];
  let r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async (u) => { asked1.push(String(u)); return String(u).includes('generativelanguage') ? J(200, { choices: [{ message: { content: 'gemini answer' } }] }) : J(500, {}); } });
  assert.equal(r.ok, true); assert.match(r.model, /^gemini:/);
  assert.equal(asked1.filter((u) => u.includes('models.github.ai')).length, 0, 'GitHub Models (retired 2026-07-30) is not a lane');

  // 2. Gemini daily 429 on both models -> OpenRouter daily quota -> Workers AI within its metered share.
  //    Usage is read with CLOUDFLARE_API_TOKEN; the model runs with CLOUDFLARE_WORKERS_AI_TOKEN
  //    (a Workers-AI-only token cannot read analytics), thinking off, OpenAI-shaped answer read.
  resetLanes(); env({ GEMINI_API_KEY: 'g', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'c', CLOUDFLARE_WORKERS_AI_TOKEN: 'ai' });
  const calls = []; const auth = {}; let runBody = null;
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async (u, init) => {
    const s = String(u); calls.push(s);
    if (s.endsWith('/graphql')) auth.graphql = init.headers.authorization;
    if (s.includes('/ai/run/')) { auth.run = init.headers.authorization; runBody = JSON.parse(init.body); return J(200, { result: { choices: [{ message: { content: 'workers answer' } }] } }); }
    if (s.includes('generativelanguage')) return J(429, [{ error: { message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }]);
    if (s.includes('openrouter.ai')) return J(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
    if (s.endsWith('/graphql')) return J(200, { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 100 }, dimensions: { modelId: '@cf/google/gemma-4-26b-a4b-it' } }, { sum: { totalNeurons: 5000 }, dimensions: { modelId: '@cf/mistralai/mistral-small-3.1-24b-instruct' } }] }] } } });
    if (s.includes('/ai/run/')) return J(200, { result: { response: 'workers answer' } });
    return J(500, {});
  } });
  assert.equal(r.ok, true); assert.match(r.model, /^workers:/); assert.equal(r.answer, 'workers answer');
  assert.equal(auth.graphql, 'Bearer c', 'usage read with CLOUDFLARE_API_TOKEN');
  assert.equal(auth.run, 'Bearer ai', 'model run with CLOUDFLARE_WORKERS_AI_TOKEN');
  assert.equal(runBody.chat_template_kwargs?.enable_thinking, false, 'thinking off: the output budget is the answer');
  assert.match(laneState.closed.gemini, /daily quota/);
  assert.match(laneState.closed.openrouter, /free-models-per-day/);
  assert.equal(calls.filter((c) => c.includes('openrouter.ai')).length, 1, 'a used-up daily quota closes the lane at once');

  // 2b. A withdrawn Workers AI model closes the lane for the run (one request, not one per page).
  resetLanes(); env({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'c' });
  let runs = 0;
  const gone = async (u) => { const s = String(u); if (s.includes('/ai/run/')) { runs++; return J(400, { success: false, errors: [{ code: 5018, message: 'AiError: Ai: This account is not allowed to access @cf/google/gemma-3-12b-it.' }] }); } return s.endsWith('/graphql') ? J(200, { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } } }) : J(500, {}); };
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: gone });
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: gone });
  assert.equal(runs, 1); assert.match(laneState.closed.workers, /not allowed to access/);

  // 3. Workers AI fails CLOSED when today's usage cannot be read, and when the share is used.
  resetLanes(); env({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'c' });
  let ran = 0;
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: async (u) => { if (String(u).includes('/ai/run/')) ran++; return String(u).endsWith('/graphql') ? J(200, { errors: [{ message: 'not authorized' }] }) : J(500, {}); } });
  assert.equal(r.ok, false); assert.equal(ran, 0, 'no Workers AI call without a usage reading'); assert.match(laneState.closed.workers, /fails closed/);
  resetLanes();
  r = await freeChat({ cfg, messages: msgs, apiKey: undefined, sleepImpl: noSleep, fetchImpl: async (u) => { if (String(u).includes('/ai/run/')) ran++; return J(200, { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 590 }, dimensions: { modelId: '@cf/google/gemma-4-26b-a4b-it' } }] }] } } }); } });
  assert.equal(ran, 0, 'share used -> no call'); assert.match(laneState.closed.workers, /share/);
  assert.ok(worstNeurons({ neurons_per_m_input: 31400, neurons_per_m_output: 50600 }, msgs, 3500) > 177);

  // 4. Per-minute 429 everywhere -> back off, then succeed on the next round.
  resetLanes(); env({ GEMINI_API_KEY: 'g' });
  let n = 0; const waits = [];
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: async (ms) => waits.push(ms), fetchImpl: async (u) => { if (String(u).includes('generativelanguage')) { n++; return n <= loadRouting(cfg).gemini.length ? J(429, {}, { 'retry-after': '20' }) : J(200, { choices: [{ message: { content: 'after backoff' } }] }); } return J(429, {}, { 'retry-after': '20' }); } });
  assert.equal(r.ok, true); assert.ok(waits.length >= 1, 'backed off before retrying');

  // 5. Every lane out -> NO_FREE_MODEL, rate-limited (BUILD drops to slow and requeues).
  resetLanes(); env({ GEMINI_API_KEY: 'g' });
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async () => J(429, { error: { message: 'free-models-per-day' } }, { 'retry-after': '90000' }) });
  assert.equal(r.ok, false); assert.equal(r.stop, 'NO_FREE_MODEL'); assert.equal(r.rateLimited, true);

  // 6. A non-zero cost fails loud.
  resetLanes(); env({});
  await assert.rejects(freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async () => J(200, { usage: { cost: 0.01 }, choices: [{ message: { content: 'x' } }] }) }), /FAIL_LOUD/);

  // 7. A dead endpoint answering HTTP 200 text/plain "OK" (what models.github.ai does since its
  //    retirement) closes that lane after ONE request, and the next lane answers.
  resetLanes(); env({ GEMINI_API_KEY: 'g' });
  const asked7 = [];
  r = await freeChat({ cfg, messages: msgs, apiKey: 'k', sleepImpl: noSleep, fetchImpl: async (u) => { asked7.push(String(u)); return String(u).includes('generativelanguage') ? new Response('OK\r\n', { status: 200, headers: { 'content-type': 'text/plain' } }) : J(200, { choices: [{ message: { content: 'openrouter answer' } }] }); } });
  assert.equal(r.ok, true); assert.ok(!/^gemini:/.test(r.model), `answered by ${r.model}`);
  assert.equal(asked7.filter((u) => u.includes('generativelanguage')).length, 1, 'a non-JSON 200 closes the lane after one request');
  assert.match(laneState.closed.gemini, /HTTP 200 with no JSON \(text\/plain "OK/);
  env({});
});

test('stagger spreads sites across 0-39 minutes, deterministically', async () => {
  const { staggerMinutes } = await import('../bin/search-loop.mjs');
  const s = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'].map(staggerMinutes);
  assert.ok(s.every((m) => m >= 0 && m < 40));
  assert.ok(new Set(s).size >= 4);
  assert.equal(staggerMinutes('a.com'), staggerMinutes('a.com'));
});

test('a free model that never answers cannot hang the run: request timeout, call budget, run budget', { timeout: 10000 }, async () => {
  const { freeChat, resetLanes, laneState, loadRouting } = await import('../src/llm.mjs');
  const { runClock, startClock } = await import('../src/util.mjs');
  const cfg = { root: process.cwd() };
  const msgs = [{ role: 'user', content: 'x' }];
  // Every lane hangs until the request is aborted (a stuck socket).
  let calls = 0; const asked = [];
  const hang = (u, init) => { calls++; asked.push(JSON.parse(init.body).model); return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
  process.env.GEMINI_API_KEY = 'gm';
  try {
    resetLanes(); startClock({});
    const t0 = Date.now();
    let r = await freeChat({ cfg, messages: msgs, apiKey: 'k', fetchImpl: hang, sleepImpl: async () => {}, timeoutMs: 100, callMs: 250 });
    assert.equal(r.ok, false);
    assert.equal(r.stop, 'NO_FREE_MODEL');
    const route = loadRouting(cfg);
    assert.ok(asked.length < route.gemini.length + route.models.length, `the call budget stopped the chain (${asked.length} models asked)`);
    assert.ok(Date.now() - t0 < 1000, `freeChat returned in ${Date.now() - t0}ms`);
    assert.ok(Object.keys(laneState.slow).length >= 1, 'a model that timed out is marked slow');
    assert.match(r.reason, /timed out/);
    // The slow models are skipped for the rest of the run: the next call does not re-wait on them.
    const slowBefore = Object.keys(laneState.slow).map((k) => k.split(':').slice(1).join(':'));
    const askedBefore = asked.length;
    r = await freeChat({ cfg, messages: msgs, apiKey: 'k', fetchImpl: hang, sleepImpl: async () => {}, timeoutMs: 100, callMs: 250 });
    const again = asked.slice(askedBefore).filter((m) => slowBefore.includes(m));
    assert.deepEqual(again, [], `a model that used its full timeout is not asked again in the run: ${again.join(', ')}`);
    // Past the run's soft budget no model call starts at all.
    resetLanes(); runClock.softAt = Date.now() - 1;
    const n = calls;
    r = await freeChat({ cfg, messages: msgs, apiKey: 'k', fetchImpl: hang, timeoutMs: 50, callMs: 400 });
    assert.equal(r.stop, 'MODEL_TIME_BUDGET');
    assert.equal(calls, n, 'no request after the budget');
  } finally { delete process.env.GEMINI_API_KEY; startClock({}); resetLanes(); }
});

test('approval mode: an unapproved page never goes live; approved goes live, declined leaves the queue', async () => {
  const root = site({ cfg: { approval: { new_pages: true } } });
  const before = fs.readdirSync(root).sort();
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: [{ keys: ['how to plan my week as a founder', 'https://example.com/weekly-planning/'], clicks: 0, impressions: 40, position: 12 }] }), chat: distinctChat() });
  const book = () => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages;
  const queued = book();
  assert.ok(queued.length >= 2, `queued: ${r.report.notes.join(' | ')}`);
  assert.equal(r.did.build.published, 0, 'nothing published without approval');
  for (const p of queued) {
    assert.equal(p.status, 'pending_approval');
    assert.ok(!fs.existsSync(path.join(root, p.rel)), `${p.rel} must not be in the site`);
    assert.ok(fs.existsSync(path.join(root, p.pending_rel)), `${p.pending_rel} is in the queue`);
  }
  assert.deepEqual(fs.readdirSync(root).filter((f) => !before.includes(f)).sort(), ['data'], 'only the ledger and queue are written');
  assert.ok(!queued.some((p) => p.linked_from.length), 'no existing page links to an unapproved page');
  // a later run with no approvals still publishes nothing
  const r2 = await run({ root, now: new Date('2026-11-03T15:00:00Z'), 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: distinctChat() });
  assert.equal(r2.did.build.published, 0);
  for (const p of book().filter((x) => x.status === 'pending_approval')) assert.ok(!fs.existsSync(path.join(root, p.rel)));
  // owners approve one and decline one
  const [ok, no] = queued;
  fs.writeFileSync(path.join(root, 'data/search-loop/approvals.json'), JSON.stringify({ approved: [ok.slug], declined: [{ slug: no.slug }] }));
  const r3 = await run({ root, now: new Date('2026-11-04T15:00:00Z'), 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: distinctChat() });
  assert.equal(r3.did.build.published, 1);
  const after = book();
  assert.equal(after.find((p) => p.slug === ok.slug).status, 'live');
  assert.ok(fs.existsSync(path.join(root, ok.rel)));
  assert.equal(after.find((p) => p.slug === no.slug).status, 'declined');
  assert.ok(!fs.existsSync(path.join(root, no.rel)) && !fs.existsSync(path.join(root, no.pending_rel)));
  for (const p of after.filter((x) => x.status === 'pending_approval')) assert.ok(!fs.existsSync(path.join(root, p.rel)), `${p.slug} unapproved, never live`);
});

test('approval mode config is checked', async () => {
  const { checkConfig } = await import('../src/config.mjs');
  const base = JSON.parse(JSON.stringify(FIXTURE_CONFIG_RAW));
  assert.ok(checkConfig({ ...base, approval: { new_pages: 'yes' } }).some((m) => /approval.new_pages/.test(m)));
  assert.ok(checkConfig({ ...base, approval: { new_pages: true, pending_dir: '../x' } }).some((m) => /approval.pending_dir/.test(m)));
  assert.deepEqual(checkConfig({ ...base, approval: { new_pages: true } }), checkConfig(base));
});

// 6 Nov sweep: p-n-p and WPP-llm went red every day with NOTHING_DONE because the
// gate had dropped their whole queue: WPP-llm's UTM action URL read back as &amp;
// (27 of 30 drops), p-n-p's own footer Maps/Facebook links failed "allowed link
// target" (19 of 24). Both are the gate's fault: a site's chrome and an escaped
// href never drop a draft, and a search dropped under an older gate is retried.
test('gate: a UTM action URL and the site footer chrome never drop a draft; old-gate drops are retried', async () => {
  const action = 'https://example.com/download?utm_source=search-loop&utm_medium=question';
  const footer = '<footer><a href="https://www.google.com/maps?cid=123">Find us on Maps</a> <a href="https://www.facebook.com/example">Facebook page</a></footer>';
  const root = site({ cfg: { action: { label: 'Get the Example Planner', url: action }, template: { og_image: { url: 'https://example.com/og.png', width: 1200, height: 630 }, footer_html: footer } } });
  // Every search FIND would queue was dropped on 2 Nov by the old gate (no gate version).
  const first = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: [{ keys: ['how to plan my week as a founder', 'https://example.com/weekly-planning/'], clicks: 0, impressions: 40, position: 12 }] }), chat: goodChat(), stage: 'find' });
  const queued = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/targets.json'))).targets.filter((t) => t.kind === 'new');
  assert.ok(queued.length > 0 && first.did.find);
  const bookFile = path.join(root, 'data/search-loop/pages.json');
  fs.writeFileSync(bookFile, JSON.stringify({ schema: 'search-loop-pages-v1', pages: [], dropped: queued.map((t) => ({ query: t.query, at: '2026-11-02', reason: [`action: the page must end in the site's one action (${action})`] })), redirected: [] }));
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat(), stage: 'build' });
  assert.ok(r.did.build.published > 0, `published: ${r.report.notes.join(' | ')}`);
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  const newDrops = book.dropped.filter((d) => d.at !== '2026-11-02');
  for (const d of newDrops) for (const why of d.reason) assert.doesNotMatch(String(why), /one action|google\.com\/maps|facebook\.com/, why);
  const html = fs.readFileSync(path.join(root, book.pages[0].rel), 'utf8');
  assert.ok(html.includes('google.com/maps'), 'footer chrome is on the page');
  // A drop made by the current gate waits the full retry window.
  assert.ok(newDrops.every((d) => d.gate === 2));
});

// 6 Nov sweep: local-guides runs CHECK only; with 13 live pages and no checkpoint
// due yet it measured every page in Search Console and was still named NOTHING_DONE.
test('a CHECK-only run that measured live pages with none due is not NOTHING_DONE', async () => {
  const root = site();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  const next = new Date(NOW.getTime() + 86400000);
  const r = await run({ root, now: next, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat(), stage: 'check' });
  assert.ok(r.did.check.measured > 0, 'live pages measured');
  assert.equal(r.did.check.checked, 0, 'no checkpoint due a day after publishing');
  assert.equal(r.nothing, false);
  assert.match(r.census, /measured=\d+/);
  // Search Console unreadable: nothing was measured, so the run is still named.
  const bad = async (u, i) => (String(u).includes('/searchAnalytics/query') ? new Response('{}', { status: 403 }) : fakeFetch()(u, i));
  const r2 = await run({ root, now: new Date(next.getTime() + 86400000), 'global-mode': 'normal', fetchImpl: bad, chat: goodChat(), stage: 'check' });
  assert.equal(r2.did.check.measured, 0);
  assert.equal(r2.nothing, true);
});

test('a model cut short by the call deadline is not skipped for the run; a full timeout still is', { timeout: 10000 }, async () => {
  // Shape of sprylabs-hpc-site run 41439077206: three OpenRouter models used their full
  // timeout, Workers AI got the 14 s left in the call, timed out, and was skipped for the
  // run, so the next page had no lane at all and the run was named NO_FREE_MODEL.
  const { freeChat, resetLanes, laneState } = await import('../src/llm.mjs');
  const { startClock } = await import('../src/util.mjs');
  const cfg = { root: process.cwd() };
  const msgs = [{ role: 'user', content: 'x' }];
  const asked = [];
  const hang = (u, init) => { asked.push(JSON.parse(init.body).model); return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
  process.env.GEMINI_API_KEY = 'gm';
  try {
    resetLanes(); startClock({});
    const r = await freeChat({ cfg, messages: msgs, apiKey: 'k', fetchImpl: hang, sleepImpl: async () => {}, timeoutMs: 100, callMs: 250 });
    assert.equal(r.stop, 'NO_FREE_MODEL');
    const slow = Object.keys(laneState.slow);
    const askedModels = asked.length;
    assert.ok(askedModels >= 3, `the case must ask at least three models (${askedModels})`);
    assert.equal(slow.length, askedModels - 1, `only the models that had the full 100 ms are slow: ${slow.join(', ')} of ${asked.join(', ')}`);
    const cut = asked[asked.length - 1];
    assert.ok(!slow.some((k) => k.endsWith(`:${cut}`)), `the model cut short (${cut}) is not skipped for the run`);
    assert.match(r.reason + JSON.stringify(r.attempts), /cut short by the call budget/);
  } finally { delete process.env.GEMINI_API_KEY; startClock({}); resetLanes(); }
});

test('v1.7.1 page shape: a stock sentence is used at most three times; a how-to gives numbered steps', async () => {
  const { cleanDraft } = await import('../src/build.mjs');
  const { render } = await import('../src/render.mjs');
  const { fixtureConfig } = await import('../src/fixture.mjs');
  const repeatedSlots = (t) => { const w = t.toLowerCase().match(/[a-z0-9][\w'’-]*/g) || [], m = new Map(); for (let i = 0; i + 8 <= w.length; i++) { const k = w.slice(i, i + 8).join(' '); m.set(k, (m.get(k) || 0) + 1); } return [...m].filter(([, c]) => c > 3); };
  const stock = 'You give us the date and the place, and we bring everything and set it up.';
  const raw = {
    h1: 'How to Book a Birthday Party', title_lead: 'How to Book a Birthday Party', meta_description: 'm', direct_answer: `Booking is easy. ${stock}`,
    sections: [
      { heading: 'Where do you start?', paragraphs: [`Pick a weekend. ${stock}`, stock], bullets: ['Pick the date', 'Send the address'] },
      { heading: 'What happens next?', paragraphs: [`We confirm by text. ${stock} Then we arrive early.`, stock] },
    ],
    faq: [{ q: 'Do I set up?', a: `No. ${stock}` }, { q: 'Anything else?', a: `Yes. Bring candles. ${stock}` }],
    facts: [],
  };
  const visible = (d) => [d.direct_answer, ...d.sections.flatMap((s) => [...s.paragraphs, ...(s.bullets || [])]), ...d.faq.map((f) => f.a)].join(' ');
  assert.ok(repeatedSlots(visible(raw)).length > 0, 'the raw draft is template filler by the Monday sample\'s measure');
  const d = cleanDraft(raw);
  assert.deepEqual(repeatedSlots(visible(d)), [], 'no 8-word phrase is left more than three times');
  assert.equal(d.direct_answer, `Booking is easy. ${stock}`, 'the first uses are kept');
  assert.deepEqual(d.sections[0].paragraphs, [`Pick a weekend. ${stock}`, stock]);
  assert.deepEqual(d.sections[1].paragraphs, ['We confirm by text. Then we arrive early.'], 'a fourth use is dropped, and a paragraph that was only the repeat goes');
  assert.equal(d.faq[0].a, 'No.');
  assert.equal(d.faq[1].a, 'Yes. Bring candles.');
  // Negative: a draft with no repeats is returned unchanged.
  const fx = (await import('../src/fixture.mjs')).fixtureDraft();
  const same = cleanDraft(fx);
  assert.deepEqual(same.sections.map((s) => s.paragraphs), fx.sections.map((s) => s.paragraphs));
  assert.deepEqual(same.faq.map((f) => f.a), fx.faq.map((f) => f.a));
  const cfg = fixtureConfig();
  const htmlHow = render(cfg, { slug: 'how-to-book', draft: d, published: '2026-11-07' });
  assert.match(htmlHow, /<ol><li>Pick the date<\/li>/);
  assert.doesNotMatch(htmlHow, /<ul><li>Pick the date/);
  const htmlWhat = render(cfg, { slug: 'what-is', draft: { ...d, h1: 'What a party planner does', title_lead: 'What a party planner does' }, published: '2026-11-07' });
  assert.match(htmlWhat, /<ul><li>Pick the date<\/li>/);
});
test('publisher logo and sameAs reach the Organization nodes only when the config gives them', async () => {
  const { render, publisherNode } = await import('../src/render.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pub-'));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(FIXTURE_CONFIG_RAW));
  const { cfg } = (await import('../src/config.mjs')).loadConfig('c.json', dir);
  const bare = publisherNode(cfg);
  assert.equal(bare.logo, undefined);
  assert.equal(bare.sameAs, undefined);
  cfg.publisher = { name: 'Example Co', url: 'https://example.com', logo: 'https://example.com/logo.png', sameAs: ['https://profile.example.org/example'] };
  const html = render(cfg, { slug: 'x', draft: fixtureDraft(), published: '2026-11-07' });
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const article = graph.find((n) => n['@type'] === 'Article');
  for (const org of [article.author, article.publisher]) {
    assert.equal(org['@type'], 'Organization');
    assert.equal(org.logo, 'https://example.com/logo.png');
    assert.deepEqual(org.sameAs, ['https://profile.example.org/example']);
  }
});

test('site_words keeps topic words in a long site name comparable', async () => {
  const { siteWordsOf, intentWords } = await import('../src/distinct.mjs');
  const long = { site_name: "Dianne's Place Recovery Services" };
  const withBrand = { ...long, site_words: "Dianne's Place" };
  const a = intentWords('recovery housing for women', siteWordsOf(withBrand));
  const b = intentWords('recovery housing for women', siteWordsOf(long));
  assert.ok(a.size > b.size, 'the topic word "recovery" must stay when site_words names only the brand');
  assert.ok(![...intentWords("dianne's place sober living", siteWordsOf(withBrand))].some((w) => /dianne|place/.test(w)));
});
