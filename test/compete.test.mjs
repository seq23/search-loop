// v1.6.0 competition lanes: each test fails on v1.5.1 (no lanes, competition never read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { find } from '../src/find.mjs';
import { fixtureConfig } from '../src/fixture.mjs';
import { buildReport, checkReport } from '../src/report.mjs';
import { ledger } from '../src/ledger.mjs';
import { scoreTop10, canBeOneScore, laneQueue, pickLane, learnWeights, laneStats, budgetLeft, readTop10, SITE_MONTHLY_CEILING, FLEET, WEIGHT_DEFAULTS, WEIGHT_BOUNDS, NO_BRAVE_KEY, BUDGET_USED } from '../src/compete.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
process.env.GSC_SITE_URL = 'sc-domain:example.com';
delete process.env.BING_WEBMASTER_API_KEY;
const NOW = new Date('2026-11-02T15:00:00Z');

const GSC_ROWS = [
  { keys: ['weekly planning template for solo founders', 'https://example.com/weekly-planning/'], impressions: 12, position: 2 },
  { keys: ['daily planning routine for busy founders', 'https://example.com/weekly-planning/'], impressions: 20, position: 1.5 },
  ...['how to plan a week as a founder', 'weekly planning system for startups', 'founder weekly planning checklist', 'weekly planning routine ideas'].map((q, i) => ({ keys: [q, 'https://example.com/weekly-planning/'], impressions: 30 + i, position: 12 + i })),
];
const res = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeFetch({ calls = [], brave = null } = {}) {
  return async (url) => {
    const u = String(url); calls.push(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/searchAnalytics/query')) return res(200, { rows: GSC_ROWS });
    if (u.includes('suggestqueries.google.com')) { const q = new URL(u).searchParams.get('q'); return res(200, [q, [`${q} for founders`, `${q} template`]]); }
    if (u.includes('api.bing.com/osjson')) { const q = new URL(u).searchParams.get('query'); return res(200, [q, [`${q} for solo founders`]]); }
    if (u.includes('api.search.brave.com')) return brave ? brave(u) : res(500, {});
    return res(404, {});
  };
}
const tmp = () => fixtureConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'slc-')));
const noScreen = async () => ({ ok: false, reason: 'screen off in test' });
const readTargets = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg.root, 'data/search-loop/targets.json'))).targets;

const DIRS = ['psychologytoday.com', 'zocdoc.com', 'yelp.com', 'thumbtack.com', 'angi.com', 'reddit.com', 'quora.com', 'healthgrades.com', 'yellowpages.com', 'bbb.org'];
const weakTop10 = DIRS.map((d, i) => ({ url: `https://www.${d}/x/${i}`, title: `Find providers ${i}`, description: 'Browse listings and reviews from people near you, compare ratings and book.' }));
const strongTop10 = Array.from({ length: 10 }, (_, i) => ({ url: `https://expert${i}.org/guide`, title: 'Black therapist in Memphis: how to find one', description: 'A full answer to finding a Black therapist in Memphis, with what to ask, costs, insurance and next steps.', page_age: '2026-09-01T00:00:00' }));

test('lane split: FIND labels every target, BUILD order holds about 2 can-be-#1 to 1 striking', async () => {
  const cfg = tmp();
  delete process.env.BRAVE_SEARCH_API_KEY;
  await find(cfg, { fetchImpl: fakeFetch(), now: NOW, index: [], chat: noScreen });
  const t = readTargets(cfg);
  assert.ok(t.length >= 9, `targets: ${t.length}`);
  for (const x of t) {
    assert.ok(['can_be_one', 'striking'].includes(x.lane), `lane on ${x.query}`);
    assert.equal(typeof x.score, 'number');
    assert.ok(Array.isArray(x.reasons) && x.reasons.length > 0, `reasons on ${x.query}`);
  }
  const first9 = t.slice(0, 9).map((x) => x.lane);
  assert.equal(first9.filter((l) => l === 'can_be_one').length, 6, first9.join(','));
  assert.equal(first9.filter((l) => l === 'striking').length, 3, first9.join(','));
  // striking lane keeps the searches the site already ranks 8-30 for
  assert.ok(t.filter((x) => x.lane === 'striking').every((x) => x.signals.gsc_position >= 8 || x.signals.google_suggest || x.signals.bing_suggest));
  // BUILD's live queue: skips in one lane don't skew the split of pages made
  const made = { can_be_one: 0, striking: 0 };
  const q = laneQueue(t, { can_be_one: 2, striking: 1 }, made);
  let n = 0;
  for (let x = q.next(); x && made.can_be_one + made.striking < 9; x = q.next()) { if (n++ % 4 === 1) continue; made[x.lane]++; }
  assert.deepEqual(made, { can_be_one: 6, striking: 3 });
  // an empty lane hands its turn over instead of wasting the quota
  assert.equal(pickLane({ can_be_one: 0, striking: 5 }, { can_be_one: 2, striking: 1 }, { can_be_one: false, striking: true }), 'striking');
});

test('a weak top 10 (all directories and forums) outscores a strong one', () => {
  const q = 'black therapist memphis';
  const weak = scoreTop10(weakTop10, { query: q, places: ['memphis'], now: NOW });
  const strong = scoreTop10(strongTop10, { query: q, places: ['memphis'], now: NOW });
  assert.equal(weak.counts.directories + weak.counts.forums, 10);
  assert.ok(weak.weakness >= 0.9 && strong.weakness <= 0.1, `${weak.weakness} vs ${strong.weakness}`);
  assert.ok(canBeOneScore({ top10: weak }).score > canBeOneScore({ top10: strong }).score);
  // an off-target national page counts as weak for a local search
  const national = scoreTop10([{ url: 'https://bignational.com/therapy', title: 'Therapy guide', description: 'A national guide to therapy, with no local detail at all for any one city.' }], { query: q, places: ['memphis'], now: NOW });
  assert.equal(national.counts.off_target_national, 1);
});

test('no key: no network call to the top-10 provider, "not read" recorded, Search Console method still lanes', async () => {
  const cfg = tmp();
  delete process.env.BRAVE_SEARCH_API_KEY;
  const calls = [];
  const r = await find(cfg, { fetchImpl: fakeFetch({ calls }), now: NOW, index: [], chat: noScreen });
  assert.equal(calls.filter((u) => u.includes('api.search.brave.com')).length, 0);
  assert.equal(r.receipt.competition, NO_BRAVE_KEY);
  assert.equal(r.sources.top10, 'not read: no BRAVE_SEARCH_API_KEY');
  const t = readTargets(cfg);
  assert.ok(t.every((x) => x.signals.top10 === NO_BRAVE_KEY));
  assert.ok(t.some((x) => x.lane === 'can_be_one'), 'Search Console fallback still fills the can-be-#1 lane');
});

test('with a key: reads the top 10 within budget; weak results raise the can-be-#1 score', async () => {
  const cfg = tmp();
  process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key\n';
  const calls = []; const tokens = [];
  const brave = (u) => { tokens.push(u); return res(200, { web: { results: weakTop10 } }, { 'x-ratelimit-limit': '50, 0', 'x-ratelimit-remaining': '49, 0', 'x-ratelimit-reset': '1, 2368531' }); };
  try {
    const r = await find(cfg, { fetchImpl: fakeFetch({ calls, brave }), now: NOW, index: [], chat: noScreen });
    const used = calls.filter((u) => u.includes('api.search.brave.com')).length;
    assert.equal(used, cfg.competition.top10.daily_budget, 'stops at the daily budget');
    assert.match(r.receipt.competition, /^ok: 15 top-10 read/);
    const t = readTargets(cfg);
    assert.ok(t.some((x) => x.lane === 'can_be_one' && x.reasons.some((s) => /^weak top 10/.test(s))));
    const book = ledger(cfg).read('serp_budget');
    assert.equal(Object.values(book.months)[0], 15);
    assert.deepEqual(book.last_headers, { month_limit: 0, month_remaining: 0, month_reset_s: 2368531, policy: null });
  } finally { delete process.env.BRAVE_SEARCH_API_KEY; }
});

test('budget exhausted: no call; "not read: Brave free budget used"; fleet stays under 70% of the free credit', async () => {
  assert.ok(SITE_MONTHLY_CEILING * FLEET.sites <= FLEET.free_requests_per_month * 0.7);
  process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
  try {
    // 1. this site's monthly share used
    const cfg = tmp();
    ledger(cfg).write('serp_budget', { days: {}, months: { '2026-11': SITE_MONTHLY_CEILING } });
    const calls = [];
    const r = await find(cfg, { fetchImpl: fakeFetch({ calls }), now: NOW, index: [], chat: noScreen });
    assert.equal(calls.filter((u) => u.includes('api.search.brave.com')).length, 0);
    assert.match(r.receipt.competition, /^not read: Brave free budget used/);
    // 2. a config cannot raise its share past the fleet ceiling
    assert.equal(budgetLeft({ months: { '2026-11': SITE_MONTHLY_CEILING } }, { competition: { top10: { daily_budget: 30, monthly_budget: 999 } } }, NOW), 0);
    // 3. Brave says credit is gone (402): stop at once, and no call for the rest of the month
    const cfg2 = tmp(); const c2 = [];
    const r2 = await find(cfg2, { fetchImpl: fakeFetch({ calls: c2, brave: () => res(402, {}) }), now: NOW, index: [], chat: noScreen });
    assert.equal(c2.filter((u) => u.includes('api.search.brave.com')).length, 1);
    assert.equal(r2.receipt.competition, BUDGET_USED);
    const c3 = [];
    await find(cfg2, { fetchImpl: fakeFetch({ calls: c3, brave: () => res(200, { web: { results: [] } }) }), now: new Date('2026-11-20T15:00:00Z'), index: [], chat: noScreen });
    assert.equal(c3.filter((u) => u.includes('api.search.brave.com')).length, 0);
    // 4. quota headers with 30% or less left: stop after that call
    const cfg4 = tmp(); const c4 = [];
    const receipt = { hosts: {}, sources: {} };
    const cands = Array.from({ length: 5 }, (_, i) => ({ query: `q ${i} weekly planning`, signals: {} }));
    await readTop10(cfg4, cands, { L: ledger(cfg4), now: NOW, fetchImpl: async (u) => { c4.push(u); return res(200, { web: { results: weakTop10 } }, { 'x-ratelimit-limit': '50, 1000', 'x-ratelimit-remaining': '49, 300' }); }, receipt });
    assert.equal(c4.length, 1);
    assert.match(receipt.sources.top10, /Brave free budget used/);
  } finally { delete process.env.BRAVE_SEARCH_API_KEY; }
});

test('learning: lane hit rate in the weekly report; weights move within bounds and are logged', () => {
  const cfg = tmp();
  const L = ledger(cfg);
  const pg = (i, lane, pos, reasons) => ({ slug: `p${i}`, query: `q${i}`, lane, reasons, status: 'live', published_at: '2026-09-01', checks: { w2: { source: 'search_console', position: pos } } });
  const pages = [
    ...Array.from({ length: 6 }, (_, i) => pg(i, 'can_be_one', i < 4 ? 2 : 9, ['easy-win neighbour of "x" (top 2 with 5 impressions)'])),
    ...Array.from({ length: 6 }, (_, i) => pg(10 + i, 'can_be_one', 15, ['weak top 10 (0.9): 8 directories'])),
    ...Array.from({ length: 3 }, (_, i) => pg(20 + i, 'striking', i === 0 ? 3 : 12, [])),
  ];
  L.write('pages', { schema: 'search-loop-pages-v1', pages });
  const s = laneStats(pages);
  assert.deepEqual([s.can_be_one.measured, s.can_be_one.top3, s.can_be_one.hit_rate], [12, 4, 0.33]);
  assert.deepEqual([s.striking.measured, s.striking.top3, s.striking.hit_rate], [3, 1, 0.33]);
  const l1 = learnWeights(pages, null, { week: '2026-W45' });
  assert.ok(l1.weights.neighbour > WEIGHT_DEFAULTS.neighbour && l1.weights.weak_top10 < WEIGHT_DEFAULTS.weak_top10);
  assert.equal(l1.changes.length, 2);
  assert.ok(l1.changes.every((c) => c.from !== c.to && c.why));
  // the same week never moves twice; many weeks stay inside 0.5x-2x
  assert.deepEqual(learnWeights(pages, { ...l1, week: '2026-W45' }, { week: '2026-W45' }).changes, []);
  let cur = l1;
  for (let w = 46; w < 90; w++) cur = learnWeights(pages, cur, { week: `W${w}` });
  assert.equal(cur.weights.neighbour, WEIGHT_DEFAULTS.neighbour * WEIGHT_BOUNDS[1]);
  assert.equal(cur.weights.weak_top10, WEIGHT_DEFAULTS.weak_top10 * WEIGHT_BOUNDS[0]);
  L.write('lane_weights', { week: cur.week, weights: cur.weights, log: cur.log });
  const r = buildReport(cfg, { mode: 'normal', effectivePace: 10, now: NOW });
  assert.deepEqual(checkReport(r), []);
  assert.equal(r.lanes.can_be_one.hit_rate, 0.33);
  assert.equal(r.lanes.striking.hit_rate, 0.33);
  assert.ok(r.lanes.weight_changes.length > 0);
  // a report whose lane block lies about its shape fails the contract
  assert.ok(checkReport({ ...r, lanes: { ...r.lanes, striking: { pages: 1 } } }).length > 0);
});
