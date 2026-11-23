// v1.14.0 AI answer misses: Boss OS says where ChatGPT, Gemini or AI Overviews left the site
// out; the engine strengthens the engine page that fits, or queues a new search when none does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from '../bin/search-loop.mjs';
import { site, fakeFetch, goodChat, distinctChat, NOW } from './harness.mjs';
import { readAiMisses, vetMisses, checkPageUrl, endpoint, AI_MISSES_URL } from '../src/ai-misses.mjs';
import { decide, RESHAPE_VERSION } from '../src/check.mjs';
import { render, withRelatedLink, draftDrift, relatedLinksOf } from '../src/render.mjs';
import { fixtureConfig, fixtureDraft } from '../src/fixture.mjs';
import { duePages } from '../src/refresh.mjs';
import { checkReport } from '../src/report.mjs';
import { isoWeek } from '../src/util.mjs';

const CFG = { base_url: 'https://example.com', output: { url_prefix: '/questions/' } };
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const idOf = (prompt) => sha1(`example.com${prompt}`);
const miss = (prompt, page_url, extra = {}) => ({ id: idOf(prompt), prompt, lane: 'own', page_url, engines_missed: ['chatgpt', 'gemini'], rivals: ['rival.example.org'], cited_sources: ['https://rival.example.org/guide'], first_missed_week: 'W', fix_attempts: 0, ...extra });
const body = (misses, extra = {}) => ({ host: 'example.com', week: isoWeek(NOW), read_at: NOW.toISOString(), status: 'read', misses, ...extra });

// The fake internet plus a fake Boss OS. `boss` returns a Response or a body object.
function withBoss(boss, base = {}) {
  const inner = fakeFetch(base);
  const seen = { boss: [], all: base.calls || [] };
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(AI_MISSES_URL)) {
      seen.boss.push({ url: u, init });
      const r = typeof boss === 'function' ? await boss(u, init) : boss;
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
    }
    return inner(url, init);
  };
  f.seen = seen;
  return f;
}

// A strengthen answer the gate accepts: one new section and one new FAQ, varied words.
const VOCAB = 'calendar outcome review morning block focus habit notebook energy meeting inbox priority deadline client launch budget hiring sprint retro goal metric team weekend travel sleep coffee walk call email draft invoice roadmap pitch demo feedback lesson routine checklist template sunday friday quarter month season'.split(' ');
const words = (seed, n) => { const h = crypto.createHash('sha256').update(seed).digest(); return Array.from({ length: n }, (_, i) => VOCAB[(h[i % 32] + i * h[(i + 7) % 32]) % VOCAB.length]).join(' '); };
const strengthenAnswer = { sections: [{ heading: 'Which notebook keeps a founder week honest?', paragraphs: [`A founder week stays honest when ${words('s1', 140)}.`] }], faq: [{ q: 'Does a paper notebook still work for weekly planning?', a: `Yes. ${words('f1', 45)}.` }] };
function aiChat({ answer = strengthenAnswer, calls = [] } = {}) {
  const base = goodChat();
  return async (args) => {
    const text = args.messages.map((m) => m.content).join('\n');
    if (/answer these buyer questions without naming this page/.test(text)) { calls.push(text); return { ok: true, answer: JSON.stringify(typeof answer === 'function' ? answer(calls.length) : answer) }; }
    return base(args);
  };
}

const read = (root, f) => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop', f), 'utf8'));
const hashes = (root) => Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter((f) => /\.html$|^_redirects$/.test(f) && !f.includes('snapshots')).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const withToken = async (fn) => { const was = process.env.BOSS_OPEN_LOOPS_TOKEN; process.env.BOSS_OPEN_LOOPS_TOKEN = 'test-token'; try { return await fn(); } finally { if (was === undefined) delete process.env.BOSS_OPEN_LOOPS_TOKEN; else process.env.BOSS_OPEN_LOOPS_TOKEN = was; } };
const day = (iso) => new Date(`${iso}T15:00:00Z`);

// A site with engine pages already live (built on NOW, no Boss OS read).
async function builtSite(cfg = {}) {
  const root = site({ cfg });
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: withBoss(new Response('', { status: 503 })), chat: goodChat() });
  const pages = read(root, 'pages.json').pages.filter((p) => p.status === 'live');
  assert.ok(pages.length > 0, 'the fixture built engine pages');
  return { root, pages };
}

// ---- outage: every failed read is "could not tell", never "no misses" -------------------

test('outage: timeout, refused token, unknown host, 5xx, bad JSON, wrong host, not_read, redirect and no token all could not tell', async () => {
  const cases = {
    timeout: () => new Promise((_, rej) => setTimeout(() => rej(new Error('never')), 5000)),
    401: () => new Response('no', { status: 401 }),
    404: () => new Response('no', { status: 404 }),
    503: () => new Response('down', { status: 503 }),
    'bad JSON': () => new Response('<html>oops', { status: 200 }),
    'wrong host': () => new Response(JSON.stringify(body([], { host: 'other.example.org' })), { status: 200 }),
    'no week': () => new Response(JSON.stringify(body([], { week: 'last week' })), { status: 200 }),
    not_read: () => new Response(JSON.stringify(body([], { status: 'not_read' })), { status: 200 }),
    'no list': () => new Response(JSON.stringify(body(undefined)), { status: 200 }),
    redirect: () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example.net/' } }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const f = withBoss((u, init) => (name === 'timeout' ? new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) : fn()));
    const r = await readAiMisses(CFG, { fetchImpl: f, token: 't', timeoutMs: 50 });
    assert.equal(r.ok, false, name);
    assert.equal(r.status, 'could_not_tell', name);
    assert.deepEqual(r.misses, [], name);
    assert.ok(r.reason.length > 5, name);
  }
  const none = withBoss(body([]));
  const r = await readAiMisses(CFG, { fetchImpl: none, token: '' });
  assert.equal(r.status, 'could_not_tell');
  assert.equal(none.seen.boss.length, 0, 'no token: nothing is sent');
  // The token never follows a redirect.
  const f = withBoss(body([]));
  await readAiMisses(CFG, { fetchImpl: f, token: 'secret' });
  assert.equal(f.seen.boss[0].init.redirect, 'manual');
  assert.equal(f.seen.boss[0].init.headers.authorization, 'Bearer secret');
  assert.match(f.seen.boss[0].url, /\?host=example\.com$/);
});

test('outage in a real run: the run goes on as before and the report says not read, never "no misses"', async () => {
  const root = site();
  const r = await withToken(() => run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: withBoss(new Response('down', { status: 503 })), chat: goodChat() }));
  assert.ok(r.did.build.published > 0, 'BUILD still published');
  assert.match(r.report.ai_misses.read, /^not read: Boss OS answered HTTP 503/);
  assert.equal(r.report.ai_misses.could_not_tell, 1);
  assert.ok(r.report.notes.some((n) => /^not read: AI answer misses \(Boss OS answered HTTP 503\)/.test(n)));
  assert.match(r.census, / ai_misses=could_not_tell /);
  assert.deepEqual(checkReport(r.report), []);
  const r2 = await withToken(() => run({ root, now: NOW, 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([], { status: 'not_read' })), chat: goodChat() }));
  assert.match(r2.report.ai_misses.read, /^not read: .*not_read/);
  assert.equal(r2.report.ai_misses.could_not_tell, 2);
});

test('a test or proof run may point the reader at this machine only', () => {
  assert.equal(endpoint({}), AI_MISSES_URL);
  assert.equal(endpoint({ SEARCH_LOOP_AI_MISSES_URL: 'http://127.0.0.1:8787/x' }), 'http://127.0.0.1:8787/x');
  for (const bad of ['https://evil.example.net/x', 'http://10.0.0.5/x', 'http://127.0.0.1.evil.example.net/x', 'not a url']) assert.equal(endpoint({ SEARCH_LOOP_AI_MISSES_URL: bad }), AI_MISSES_URL, bad);
});

// ---- abuse: a lying Boss OS row is rejected and counted, never fetched or edited ----------

test('abuse: off-host, traversal, credentials, other port, repeated id, bad id and another lane are rejected', () => {
  const ok = miss('which planner app keeps founders on track', 'https://www.example.com/questions/x/');
  const dup = miss('the same id twice in one read', null);
  const rows = [
    ok,
    miss('off host page for this miss', 'https://evil.example.net/questions/x/'),
    miss('a look alike host for this miss', 'https://example.com.evil.example.net/questions/x/'),
    miss('dot segments walking out of the site', 'https://example.com/questions/../../../etc/passwd'),
    miss('encoded dot segments in the path', 'https://example.com/questions/%2e%2e/%2E%2E/secret'),
    miss('backslash path in the url here', 'https://example.com/questions\\..\\x'),
    miss('credentials hidden in the url', 'https://user:pw@example.com/questions/x/'),
    miss('another port on the same host', 'https://example.com:8443/questions/x/'),
    miss('a javascript url as the page', 'javascript:alert(1)'),
    dup, { ...dup },
    { ...miss('an id that is not sha1 hex', null), id: '__proto__' },
    miss('a row from the earn lane here', null, { lane: 'earn' }),
    miss('x', null),
  ];
  const v = vetMisses(rows, CFG);
  assert.deepEqual(v.misses.map((m) => m.id), [ok.id]);
  assert.equal(v.misses[0].page_url, 'https://example.com/questions/x');
  assert.equal(v.rejected.length, rows.length - 1);
  for (const r of v.rejected) assert.ok(r.reason, r.id);
  assert.equal(v.rejected.filter((r) => r.id === dup.id).length, 2, 'both copies of a repeated id are rejected');
  assert.equal(checkPageUrl('https://EXAMPLE.com/questions/a/', CFG).url, 'https://example.com/questions/a');

  // Boundaries: prompts of 8 and 300 characters pass, 7 and 301 do not; 100 misses a read, the 101st is rejected.
  const len = (n) => ({ ...miss('p'.repeat(n), null), id: sha1(`len${n}`) });
  assert.deepEqual(vetMisses([len(7), len(8), len(300), len(301)], CFG).misses.map((m) => m.prompt.length), [8, 300]);
  const many = Array.from({ length: 101 }, (_, i) => ({ ...miss(`buyer question number ${i}`, null) }));
  const vm = vetMisses(many, CFG);
  assert.equal(vm.misses.length, 100);
  assert.deepEqual(vm.rejected.map((r) => r.id), [many[100].id]);
  assert.deepEqual(vetMisses([], CFG), { misses: [], rejected: [] });
});

test('abuse in a real run: a rejected URL is never fetched and no page changes; the report counts it', async () => {
  const { root, pages } = await builtSite();
  const before = hashes(root);
  const calls = [];
  const rows = [miss('off host page for this miss', 'https://evil.example.net/questions/x/'), miss('dot segments walking out of the site', `${pages[0].url}../../../etc/passwd`)];
  const f = withBoss(body(rows), { calls });
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: f, chat: aiChat() }));
  assert.ok(!calls.some((u) => u.includes('evil.example.net') || u.includes('passwd')), 'never fetched');
  assert.deepEqual(hashes(root), before, 'no page edited');
  assert.deepEqual(r.report.ai_misses.rejected.map((x) => x.id).sort(), rows.map((x) => x.id).sort());
  assert.equal(r.report.ai_misses.strengthened.length, 0);
  assert.deepEqual(checkReport(r.report), []);
});

// ---- strengthen the engine page that fits ----------------------------------------------

test('a miss naming an engine page strengthens it with no Search Console gate: same gate, snapshot and undo bytes', async () => {
  const { root, pages } = await builtSite();
  const p = pages[0];
  const m = miss('best planner app to keep a founder week on track', p.url.replace('https://', 'https://www.'));
  const calls = [];
  // No Search Console position at all, and no checkpoint due (1 day old).
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m]), { pageRows: [] }), chat: aiChat({ calls }) }));
  assert.equal(calls.length, 1, 'one strengthen model call');
  assert.ok(calls[0].includes(m.prompt) && calls[0].includes('https://rival.example.org/guide'), 'the prompt and cited sources are the target');
  const after = read(root, 'pages.json').pages.find((x) => x.slug === p.slug);
  assert.equal(after.strengthen.trigger, 'ai_miss');
  assert.equal(after.strengthen.baseline_position, null);
  assert.deepEqual(after.strengthen.ai_miss_ids, [m.id]);
  assert.equal(after.modified_at, '2026-11-03');
  const html = fs.readFileSync(path.join(root, p.rel), 'utf8');
  assert.ok(html.includes('Which notebook keeps a founder week honest?'), 'the new section is on the page');
  const snap = path.join(root, 'data/search-loop/snapshots', `${after.strengthen.before_hash}.html`);
  assert.ok(fs.existsSync(snap), 'snapshot of the before bytes');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(snap)).digest('hex'), after.strengthen.before_hash);
  assert.deepEqual(r.report.ai_misses.strengthened, [{ id: m.id, page_url: p.url, at: '2026-11-03' }]);
  assert.equal(r.did.check.ai_misses.strengthened, 1);
  assert.match(r.census, /ai_misses=1\/strengthened:1\//);
  assert.deepEqual(checkReport(r.report), []);
  // Search Console can still undo it when it is measured worse (baseline known).
  const book = read(root, 'pages.json');
  book.pages.find((x) => x.slug === p.slug).strengthen.baseline_position = 12;
  fs.writeFileSync(path.join(root, 'data/search-loop/pages.json'), JSON.stringify(book));
  const r2 = await withToken(() => run({ root, now: day('2026-11-18'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(new Response('', { status: 503 }), { pageRows: pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 9, position: 25 })) }), chat: aiChat() }));
  assert.ok(r2.did.check.undone >= 1);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p.rel))).digest('hex'), after.strengthen.before_hash, 'undo restores the before bytes');
});

test('idempotent: a second run in the same Boss OS week does nothing for that id', async () => {
  const { root, pages } = await builtSite();
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const calls = [];
  const go = (d) => withToken(() => run({ root, now: day(d), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ calls }) }));
  await go('2026-11-03');
  const once = hashes(root);
  const r2 = await go('2026-11-03');
  const r3 = await go('2026-11-04');
  assert.equal(calls.length, 1, 'no second strengthen call');
  assert.deepEqual(hashes(root), once, 'no page changed again');
  assert.equal(Object.keys(read(root, 'ai-misses.json').weeks[isoWeek(NOW)]).length, 1, 'one action for the id this week');
  assert.equal(r2.did.check.ai_misses.strengthened, 0);
  assert.equal(r3.report.ai_misses.strengthened.length, 1, 'the report still shows the one strengthen of the last 7 days');

  // An id whose action this week was "added nothing" stays done for the week, even when the
  // page is free and the model would now add something.
  const b = await builtSite();
  const m2 = miss('best planner app to keep a founder week on track', b.pages[0].url);
  const draft = JSON.parse(fs.readFileSync(path.join(b.root, 'data/search-loop/drafts', `${b.pages[0].slug}.json`), 'utf8'));
  const n = [];
  const go2 = (answer) => withToken(() => run({ root: b.root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m2])), chat: aiChat({ calls: n, answer }) }));
  await go2({ sections: draft.sections.slice(0, 1), faq: [] });
  const quiet = hashes(b.root);
  await go2(strengthenAnswer);
  assert.equal(n.length, 1, 'no second call for the id this week');
  assert.deepEqual(hashes(b.root), quiet);
});

test('at most one strengthen per page per 14 days, across Boss OS weeks', async () => {
  const { root, pages } = await builtSite();
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const calls = [];
  // Each call adds something new (a repeat of what the page has is a no-op, tested below).
  const answer = (n) => (n === 1 ? strengthenAnswer : { sections: [{ heading: 'What should a founder cut from a crowded week?', paragraphs: [`Cut what ${words('s2', 140)}.`] }], faq: [{ q: 'How many priorities fit in one founder week?', a: `Three. ${words('f2', 45)}.` }] });
  const go = (d, week) => withToken(() => run({ root, now: day(d), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m], { week })), chat: aiChat({ calls, answer }) }));
  await go('2026-11-03', '2026-W45');
  const r = await go('2026-11-10', '2026-W46'); // a new week, still missed, 7 days later
  assert.equal(calls.length, 1);
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === m.id && /at most one per page per 14 days/.test(s.reason)));
  // 14 days on: the earlier strengthen settles (still missed) and the page may be strengthened again.
  const r2 = await go('2026-11-17', '2026-W47');
  const p = read(root, 'pages.json').pages.find((x) => x.slug === pages[0].slug);
  assert.deepEqual(p.strengthen_history[0].verdict.still_missed, [m.id]);
  assert.equal(calls.length, 2, 'strengthened again after 14 days');
  assert.equal(r2.did.check.ai_misses.strengthened, 1);
});

test('settle: no longer listed -> kept ai_miss; a null baseline with no newer read still settles and the page is refreshed 30 days later', async () => {
  const { root, pages } = await builtSite();
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const go = (d, boss) => withToken(() => run({ root, now: day(d), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(boss, { pageRows: [] }), chat: aiChat() }));
  await go('2026-11-03', body([m], { week: '2026-W45' }));
  await go('2026-11-17', body([], { week: '2026-W47' }));
  const kept = read(root, 'pages.json').pages.find((x) => x.slug === pages[0].slug);
  assert.equal(kept.strengthen.verdict.kept, 'ai_miss');

  // No Search Console data and Boss OS down from the day after: the strengthen still settles.
  const b = await builtSite();
  const m2 = miss('best planner app to keep a founder week on track', b.pages[0].url);
  const go2 = (d, boss) => withToken(() => run({ root: b.root, now: day(d), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(boss, { pageRows: [] }), chat: aiChat() }));
  await go2('2026-11-03', body([m2], { week: '2026-W45' }));
  for (const d of ['2026-11-17', '2026-11-24', '2026-12-01']) await go2(d, new Response('', { status: 503 }));
  const settled = read(b.root, 'pages.json').pages.find((x) => x.slug === b.pages[0].slug);
  assert.equal(settled.strengthen.baseline_position, null);
  assert.match(settled.strengthen.verdict.ai_miss, /^not read: /);
  const live = read(b.root, 'pages.json').pages.filter((x) => x.status === 'live');
  assert.ok(duePages(live, '2026-12-03').due.some((x) => x.slug === b.pages[0].slug), 'due for refresh 30 days after the strengthen');
});

// ---- hand-edited pages: a re-render from a stale draft would undo the edit -------------------

// The keepmyproof proof run (22 Nov 2026) re-rendered a page from its draft and put back a
// recording-law sentence a hand fix (#46) had corrected in the page only.
const handEdit = (root, p) => {
  const file = path.join(root, p.rel);
  const draft = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/drafts', `${p.slug}.json`), 'utf8'));
  const was = fs.readFileSync(file, 'utf8');
  const html = was.replace(`<p>${draft.sections[0].paragraphs[0]}</p>`, '<p>A hand-corrected paragraph that the saved draft does not have.</p>');
  assert.notEqual(html, was, 'the fixture made a hand edit');
  fs.writeFileSync(file, html);
  return html;
};

test('a page edited by hand after its draft was saved is never re-rendered by an AI-miss strengthen; the miss is recorded with the reason', async () => {
  const { root, pages } = await builtSite();
  const p = pages[0];
  const hand = handEdit(root, p);
  const before = hashes(root);
  const m = miss('best planner app to keep a founder week on track', p.url);
  const calls = [];
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m]), { pageRows: [] }), chat: aiChat({ calls }) }));
  assert.equal(fs.readFileSync(path.join(root, p.rel), 'utf8'), hand, 'the hand edit is kept');
  assert.deepEqual(hashes(root), before);
  assert.equal(calls.length, 0, 'no model call for a page that will not be re-rendered');
  assert.equal(read(root, 'pages.json').pages.find((x) => x.slug === p.slug).strengthen, undefined);
  const skip = r.report.ai_misses.skipped.find((x) => x.id === m.id);
  assert.match(skip?.reason || '', /edited after its draft was saved, so a re-render would undo that edit; left as it is \(the (draft|page) says "/);
  assert.equal(read(root, 'ai-misses.json').weeks[isoWeek(NOW)][m.id].action, 'skipped', 'recorded once for the week');
});

test('a reshape never re-renders a page whose words differ from its draft', async () => {
  const { root, pages } = await builtSite();
  const p = pages[0];
  // Filler in the page only (not in the draft): a re-render would also drop whatever else was edited.
  const f = path.join(root, p.rel);
  const html = fs.readFileSync(f, 'utf8').replace(/(<section><h2>[^<]*<\/h2>)/g, '$1<p>You give us the date and the place, and we bring everything.</p>');
  fs.writeFileSync(f, html);
  const book = read(root, 'pages.json');
  for (const x of book.pages) delete x.reshaped;
  fs.writeFileSync(path.join(root, 'data/search-loop/pages.json'), JSON.stringify(book));
  const r = await run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(new Response('', { status: 503 })), chat: distinctChat() });
  assert.equal(fs.readFileSync(f, 'utf8'), html, 'left byte-identical');
  const after = read(root, 'pages.json').pages.find((x) => x.slug === p.slug);
  assert.equal(after.reshaped.v, RESHAPE_VERSION);
  assert.match(after.reshaped.left.join(' '), /edited after its draft was saved/);
  assert.ok(!r.did.check.reshaped, 'nothing reshaped');
});

test('related links in either form survive a strengthen', async () => {
  const { root, pages } = await builtSite();
  const p = pages[0];
  const f = path.join(root, p.rel);
  // The marked block BUILD adds when a newer page links back (withRelatedLink).
  const linked = withRelatedLink(fs.readFileSync(f, 'utf8'), { route: '/questions/a-later-page/', anchor: 'A later page & more' });
  assert.ok(linked && linked.includes('/questions/a-later-page/'));
  fs.writeFileSync(f, linked);
  const m = miss('best planner app to keep a founder week on track', p.url);
  await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m]), { pageRows: [] }), chat: aiChat() }));
  const html = fs.readFileSync(f, 'utf8');
  assert.ok(html.includes('Which notebook keeps a founder week honest?'), 'strengthened');
  assert.deepEqual(relatedLinksOf(html).map((x) => [x.route, x.anchor]), relatedLinksOf(linked).map((x) => [x.route, x.anchor]), 'every related link kept');
  assert.ok(relatedLinksOf(linked).some((x) => x.anchor === 'A later page & more'));
});

test('draftDrift: a page rendered from its draft matches; a changed, removed or added paragraph does not; layout, dates, sources and related links are not compared', () => {
  const cfg = fixtureConfig(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sl-drift-')));
  const d = fixtureDraft();
  d.sections[0].paragraphs[0] = `Plan the week's "big three" & leave room <for> surprises. ${d.sections[0].paragraphs[0]}`;
  const html = render(cfg, { slug: 'plan', draft: d, published: '2026-11-01' });
  assert.deepEqual(draftDrift(html, d), [], 'escaped quotes, ampersands and angle brackets still match');
  assert.deepEqual(draftDrift(html.replace(/'/g, '&#39;').replace(/&amp;/g, '&#38;').replace(/week's/g, 'week&rsquo;s'), d), [], 'the same words written with other entities still match');
  // Dates, related links and the sources list differ: still a match.
  const moved = withRelatedLink(render(cfg, { slug: 'plan', draft: d, related: [{ route: '/questions/x/', anchor: 'X' }], published: '2026-11-01', modified: '2026-11-20' }), { route: '/questions/y/', anchor: 'Y' });
  assert.deepEqual(draftDrift(moved, { ...d, facts: [] }), []);
  const para = d.sections[1].paragraphs[0];
  const changed = html.replace(para, 'A different paragraph written by hand.');
  assert.equal(draftDrift(changed, d).length, 2, 'the draft text is missing and the hand text is extra');
  assert.match(draftDrift(html.replace(`<p>${para}</p>`, ''), d)[0], /^the draft says/);
  assert.match(draftDrift(html.replace('</h1>', '</h1><section><p>Added by hand.</p></section>'), d)[0], /^the page says "added by hand"/);
  assert.match(draftDrift(html.replace(d.faq[0].a.replace(/'/g, '&#39;'), 'A new answer.').replace(d.faq[0].a, 'A new answer.'), d).join(' '), /the draft says/);
  assert.deepEqual(draftDrift('<html><body>no article</body></html>', d), ['the page has no <article> to compare with its draft']);
});

test('a miss naming a page that is not an engine page is skipped with that reason, and the page is untouched', async () => {
  const { root } = await builtSite();
  const before = hashes(root);
  const m = miss('weekly planning for founders who travel', 'https://example.com/weekly-planning/');
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat() }));
  assert.deepEqual(r.report.ai_misses.skipped, [{ id: m.id, reason: 'not an engine page' }]);
  assert.deepEqual(hashes(root), before);
});

test('freshness: a strengthen that adds nothing keeps the page, its draft and its dates', async () => {
  const { root, pages } = await builtSite();
  const p = pages[0];
  const draft = fs.readFileSync(path.join(root, 'data/search-loop/drafts', `${p.slug}.json`), 'utf8');
  const before = hashes(root);
  const sameAgain = JSON.parse(draft);
  const m = miss('best planner app to keep a founder week on track', p.url);
  // The model returns only what the page already has.
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ answer: { sections: sameAgain.sections.slice(0, 1), faq: sameAgain.faq.slice(0, 1) } }) }));
  const after = read(root, 'pages.json').pages.find((x) => x.slug === p.slug);
  assert.deepEqual(hashes(root), before, 'page bytes unchanged');
  assert.equal(fs.readFileSync(path.join(root, 'data/search-loop/drafts', `${p.slug}.json`), 'utf8'), draft);
  assert.equal(after.modified_at, p.modified_at);
  assert.equal(after.strengthen, undefined);
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === m.id && /added nothing new/.test(s.reason)));
});

test('gate: a strengthen the gate refuses leaves the page as it was', async () => {
  const { root, pages } = await builtSite();
  const before = hashes(root);
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const bad = { sections: [{ heading: 'What planners cost', paragraphs: [`Most planners charge $79 a month ${words('g', 140)}.`] }], faq: [] };
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ answer: bad }) }));
  assert.deepEqual(hashes(root), before);
  assert.equal(read(root, 'pages.json').pages.find((x) => x.slug === pages[0].slug).strengthen, undefined);
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === m.id && /failed the gate/.test(s.reason)));
});

test('frozen sites: nothing is modified or built for a miss; every miss is recorded only', async () => {
  const { root, pages } = await builtSite({ published_pages_frozen: true });
  const before = hashes(root);
  const calls = [];
  const misses = [miss('best planner app to keep a founder week on track', pages[0].url), miss('which weekly planner do remote founders use', null)];
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', fetchImpl: withBoss(body(misses)), chat: aiChat({ calls }) }));
  assert.equal(calls.length, 0, 'no strengthen call');
  for (const [f, h] of Object.entries(before)) assert.equal(hashes(root)[f], h, `${f} changed`);
  assert.equal(r.did.find, null, 'FIND is not run again for a frozen site\'s miss');
  assert.ok(!read(root, 'targets.json').targets.some((t) => t.ai_miss_ids), 'no candidate queued');
  assert.deepEqual(r.report.ai_misses.skipped.map((s) => s.id).sort(), misses.map((m) => m.id).sort());
  assert.ok(r.report.ai_misses.skipped.every((s) => /frozen/.test(s.reason)));
});

test('a free model outage during an AI-miss strengthen is not recorded: the page is untouched and a later run acts', async () => {
  const { root, pages } = await builtSite();
  const before = hashes(root);
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const down = async (args) => (/answer these buyer questions without naming this page/.test(args.messages.map((x) => x.content).join('\n')) ? { ok: false, reason: 'every free lane is out' } : goodChat()(args));
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: down }));
  assert.deepEqual(hashes(root), before);
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === m.id && /no free model answered/.test(s.reason)));
  assert.equal(read(root, 'ai-misses.json').weeks[isoWeek(NOW)]?.[m.id], undefined, 'not recorded as done');
  const calls = [];
  await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ calls }) }));
  assert.equal(calls.length, 1, 'the next run strengthens it');
});

test('mode slow or off never strengthens for a miss; the skip is not recorded, so a later normal run acts', async () => {
  const { root, pages } = await builtSite();
  const m = miss('best planner app to keep a founder week on track', pages[0].url);
  const calls = [];
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'off', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ calls }) }));
  assert.equal(calls.length, 0);
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === m.id && /mode=off/.test(s.reason)));
  await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([m])), chat: aiChat({ calls }) }));
  assert.equal(calls.length, 1);
});

// ---- no page fits: a new search through every gate -------------------------------------

test('a miss with no page becomes a FIND candidate the same week, led first, and BUILD writes it through every gate', async () => {
  const { root, pages } = await builtSite({ cap: { max_per_day: 1 } });
  const fresh = miss('which weekly planner do remote founders use', null);
  const dup = miss(pages[0].query, null); // an engine page already has this intent
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', fetchImpl: withBoss(body([fresh, dup])), chat: distinctChat() }));
  assert.ok(r.did.find, 'FIND ran again for the new miss');
  const t = read(root, 'targets.json');
  assert.deepEqual(t.targets[0].ai_miss_ids, [fresh.id], 'the miss leads the list');
  assert.match(t.targets[0].reasons[0], /^AI answer miss/);
  assert.ok(r.report.ai_misses.new_candidates.some((c) => c.id === fresh.id && c.prompt === 'which weekly planner do remote founders use'));
  assert.ok(r.report.ai_misses.skipped.some((s) => s.id === dup.id && /an engine page already has this intent/.test(s.reason)));
  const book = read(root, 'pages.json');
  const today = book.pages.filter((p) => p.published_at === '2026-11-03');
  assert.deepEqual(today.map((p) => [p.query, p.status]), [['which weekly planner do remote founders use', 'live']], `BUILD took it first under a 1-a-day cap: ${r.report.notes.join(' | ')}`);
  assert.deepEqual(checkReport(r.report), []);
  // The next run the same week does not run FIND again for it.
  const r2 = await withToken(() => run({ root, now: day('2026-11-04'), 'global-mode': 'normal', fetchImpl: withBoss(body([fresh, dup])), chat: distinctChat() }));
  assert.equal(r2.did.find, null);
});

// ---- the GSC path keeps its rules ------------------------------------------------------

test('decide: an AI-miss strengthen does not use up the one Search Console strengthen, and is kept only by the next AI read', () => {
  const rules = { strengthen: true, undo: true, merge: true };
  const snap = { checkpoint: 'w4', position: 14, clicks: 0, impressions: 5, source: 'search_console' };
  const aiDone = { published_at: '2026-10-01', strengthen: { at: '2026-10-05', trigger: 'ai_miss', baseline_position: 14, verdict: { kept: 'ai_miss' } } };
  assert.ok(decide(aiDone, snap, { rules, today: '2026-10-29' }).includes('strengthen'));
  const gscDone = { published_at: '2026-10-01', strengthen: { at: '2026-10-05', trigger: 'ai_miss', verdict: { kept: true } }, strengthen_history: [{ at: '2026-09-01', baseline_position: 15, verdict: { kept: true } }] };
  assert.ok(!decide(gscDone, snap, { rules, today: '2026-10-29' }).includes('strengthen'), 'Search Console strengthens once ever');
  const aiInFlight = { published_at: '2026-10-01', strengthen: { at: '2026-10-05', trigger: 'ai_miss', baseline_position: 14 } };
  assert.deepEqual(decide(aiInFlight, { ...snap, checkpoint: 'settle' }, { rules, today: '2026-10-29' }), [], 'not kept by Search Console');
  assert.deepEqual(decide(aiInFlight, { ...snap, checkpoint: 'settle', position: 25 }, { rules, today: '2026-10-29' }), ['undo']);
});

test('a Search Console strengthen that adds nothing keeps the page and its dates too', async () => {
  const { root, pages } = await builtSite();
  const before = hashes(root);
  const echo = async ({ messages }) => {
    if (/sits just off page one/.test(messages[1].content)) return { ok: true, answer: '{"sections":[],"faq":[]}' };
    return goodChat()({ messages });
  };
  await run({ root, now: day('2026-11-30'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(new Response('', { status: 503 }), { pageRows: pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 14 })) }), chat: echo });
  const after = read(root, 'pages.json').pages;
  assert.ok(after.every((p) => !p.strengthen), 'nothing recorded as strengthened');
  for (const p of pages) assert.equal(hashes(root)[p.rel], before[p.rel], `${p.rel} changed`);
});

// ---- the report contract ---------------------------------------------------------------

// A copy of Boss OS weekProblem (boss-os src/shared/boss/searchLoop/week.mjs, 22 Nov 2026):
// an old reader must still parse a v1.14.0 line.
function weekProblem(week, { now = new Date(), maxAgeDays = 8 } = {}) {
  if (!week || typeof week !== 'object') return 'no search-loop-week report';
  if (week.schema !== 'search-loop-week-v1') return `schema is ${week.schema || 'missing'}, not search-loop-week-v1`;
  if (!week.site) return 'report names no site';
  const at = Date.parse(week.generated_at);
  if (!Number.isFinite(at)) return 'report has no generated_at';
  const age = (now.getTime() - at) / 86400000;
  if (age > maxAgeDays) return `report is ${Math.floor(age)} days old`;
  return null;
}

test('report: the ai_misses block is additive; an old Boss OS reader still parses a v1.14.0 line', async () => {
  const { root, pages } = await builtSite();
  const r = await withToken(() => run({ root, now: day('2026-11-03'), 'global-mode': 'normal', stage: 'check', fetchImpl: withBoss(body([miss('best planner app to keep a founder week on track', pages[0].url)])), chat: aiChat() }));
  const line = JSON.parse(fs.readFileSync(r.out, 'utf8'));
  assert.equal(weekProblem(line, { now: day('2026-11-03') }), null);
  assert.deepEqual(Object.keys(line.ai_misses).sort(), ['could_not_tell', 'misses', 'new_candidates', 'read', 'rejected', 'skipped', 'strengthened', 'week']);
  const schema = JSON.parse(fs.readFileSync(new URL('../schema/search-loop-week-v1.json', import.meta.url)));
  assert.ok(!schema.required.includes('ai_misses'));
  const old = { ...line }; delete old.ai_misses;
  assert.deepEqual(checkReport(old), [], 'a report without the block (older engine) is still valid');
  assert.ok(checkReport({ ...line, ai_misses: { ...line.ai_misses, read: 'fine' } }).length > 0, 'a bad block is caught');
  assert.ok(checkReport({ ...line, ai_misses: { ...line.ai_misses, strengthened: 3 } }).length > 0, 'strengthened is a list, not a count');
});
