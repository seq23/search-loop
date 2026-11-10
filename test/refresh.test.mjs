// v1.10.0 REFRESH: a due question page gets its sources re-checked and one real-search question,
// and its date moves only when what it says changed (risk rule R-ADV-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureConfig, fixtureDraft } from '../src/fixture.mjs';
import { render } from '../src/render.mjs';
import { ledger } from '../src/ledger.mjs';
import { duePages, recheckSources, openQueries, entryProblems, refreshPages, MAX_PER_RUN } from '../src/refresh.mjs';

process.env.GSC_SITE_URL = 'sc-domain:example.com';
const crypto = await import('node:crypto');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });

const live = (o) => ({ slug: 's', route: '/questions/s/', url: 'https://example.com/questions/s/', rel: 'questions/s/index.html', status: 'live', query: 'how to plan my week', published_at: '2026-09-01', ...o });

test('due pages: oldest first, 30 days since the last real touch, at the pace, never mid-strengthen', () => {
  const pages = [
    live({ slug: 'a', route: '/a/', published_at: '2026-08-01' }),
    live({ slug: 'b', route: '/b/', published_at: '2026-07-01', modified_at: '2026-10-20' }),
    live({ slug: 'c', route: '/c/', published_at: '2026-06-01', refreshed: { at: '2026-10-25', changes: [] } }),
    live({ slug: 'd', route: '/d/', published_at: '2026-05-01', strengthen: { at: '2026-09-01' } }),
    live({ slug: 'e', route: '/e/', published_at: '2026-07-15' }),
  ];
  const { due, take } = duePages(pages, '2026-11-10');
  assert.deepEqual(due.map((p) => p.slug), ['e', 'a'], 'checked or changed within 30 days is not due; mid-strengthen is skipped');
  assert.equal(take, 1);
  assert.equal(duePages(Array.from({ length: 500 }, (_, i) => live({ slug: `x${i}` })), '2026-11-10').take, MAX_PER_RUN);
});

test('a gone source takes its fact off; a blocked or slow one stays; the last sourced fact is never dropped', async () => {
  const fetchImpl = async (u) => new Response('x', { status: u.includes('gone') ? 404 : u.includes('blocked') ? 403 : 200 });
  const facts = [{ claim: 'a', source_url: 'https://gone.example/' }, { claim: 'b', source_url: 'https://blocked.example/' }, { claim: 'c', source_url: 'https://ok.example/' }];
  const r = await recheckSources(facts, fetchImpl);
  assert.deepEqual(r.gone.map((f) => f.claim), ['a']);
  assert.deepEqual(r.facts.map((f) => f.claim), ['b', 'c']);
  const only = await recheckSources([{ claim: 'a', source_url: 'https://gone.example/' }], fetchImpl);
  assert.equal(only.gone.length, 0);
  assert.match(only.left, /every source is gone/);
});

test('only real searches the page does not answer become questions; answers use only the page', () => {
  const d = fixtureDraft();
  const rows = [{ query: 'how long should weekly planning take', impressions: 30 }, { query: 'weekly planning on a sunday evening', impressions: 4 }, { query: 'planning', impressions: 99 }];
  assert.deepEqual(openQueries(d, rows).map((r) => r.query), ['weekly planning on a sunday evening']);
  const good = { q: 'Is weekly planning on a Sunday evening a good idea?', a: 'Yes. Pick one block of time on Sunday or Monday, write down the three outcomes that matter, and leave space for the work that always shows up unplanned. The exact hour matters less than keeping it fixed, because a fixed slot turns planning into a habit that survives busy weeks.' };
  assert.deepEqual(entryProblems(good, d, 'weekly planning on a sunday evening'), []);
  assert.ok(entryProblems({ ...good, a: good.a + ' It saves 47 minutes.' }, d, 'weekly planning on a sunday evening').some((p) => p.includes('47')));
  assert.ok(entryProblems({ ...good, a: good.a.replace('Pick', 'Pick, as Notion says,') }, d, 'weekly planning on a sunday evening').some((p) => p.includes('Notion')));
  assert.ok(entryProblems({ ...good, q: 'What is a calendar?' }, d, 'weekly planning on a sunday evening').length);
});

function pageSite(extraFacts = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-refresh-'));
  const cfg = fixtureConfig(root);
  const L = ledger(cfg);
  const d = fixtureDraft();
  d.facts = [...d.facts, ...extraFacts];
  const p = live({ slug: 'plan', route: '/questions/plan/', url: 'https://example.com/questions/plan/', rel: 'questions/plan/index.html', published_at: '2026-09-01' });
  fs.mkdirSync(path.join(root, 'questions/plan'), { recursive: true });
  fs.mkdirSync(path.join(L.dir, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(root, p.rel), render(cfg, { slug: p.slug, draft: d, published: p.published_at }));
  fs.writeFileSync(path.join(L.dir, 'drafts', 'plan.json'), JSON.stringify(d));
  return { root, cfg, L, p };
}
const gscFetch = (rows) => async (u) => {
  const s = String(u);
  if (s.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  if (s.includes('/searchAnalytics/query')) return new Response(JSON.stringify({ rows: rows.map((r) => ({ keys: [r.query], impressions: r.impressions, clicks: 0, position: 20 })) }), { status: 200 });
  return new Response('<html>' + 'x'.repeat(1000) + '</html>', { status: 200 });
};
const answerChat = async () => ({ ok: true, answer: JSON.stringify({ q: 'Is weekly planning on a Sunday evening a good idea?', a: 'Yes. Pick one block of time on Sunday or Monday, write down the three outcomes that matter, and leave space for the work that always shows up unplanned. The exact hour matters less than keeping it fixed, because a fixed slot turns planning into a habit that survives busy weeks.' }) });

test('a real search becomes a question on the page, and only then the date moves', async () => {
  const { root, cfg, L, p } = pageSite();
  const res = await refreshPages(cfg, L, [p], { today: '2026-11-10', now: new Date('2026-11-10T15:00:00Z'), rules: { strengthen: true }, chat: answerChat, fetchImpl: gscFetch([{ query: 'weekly planning on a sunday evening', impressions: 6 }]) });
  assert.equal(res.refreshed, 1);
  const html = fs.readFileSync(path.join(root, p.rel), 'utf8');
  assert.ok(html.includes('Is weekly planning on a Sunday evening a good idea?'));
  assert.ok(html.includes('Updated <time datetime="2026-11-10">'));
  assert.equal(p.modified_at, '2026-11-10');
  assert.deepEqual(p.refreshed.changes, ['question added from a real search: "weekly planning on a sunday evening"']);
});

test('nothing to fix: the page file, its hash and its dates are left alone (negative proof)', async () => {
  const { root, cfg, L, p } = pageSite();
  const before = fs.readFileSync(path.join(root, p.rel), 'utf8');
  const notes = [];
  const res = await refreshPages(cfg, L, [p], { today: '2026-11-10', rules: { strengthen: true }, chat: answerChat, fetchImpl: gscFetch([{ query: 'how long should weekly planning take', impressions: 30 }]), notes });
  assert.equal(res.refreshed, 0);
  assert.equal(fs.readFileSync(path.join(root, p.rel), 'utf8'), before);
  assert.equal(p.modified_at, undefined);
  assert.equal(p.refreshed.at, '2026-11-10');
  assert.deepEqual(p.refreshed.changes, []);
  assert.ok(notes.some((n) => n.startsWith('NAMED NOTE [REFRESH_NOTHING_CHANGED]')));
  // Checked today: not due again for 30 days.
  assert.equal(duePages([p], '2026-11-20').due.length, 0);
});

test('slow mode still repairs a gone source but drafts no question', async () => {
  const { cfg, L, p } = pageSite([{ claim: 'A week has seven days.', source_url: 'https://en.wikipedia.org/wiki/Week', source_name: 'Wikipedia', verified: true }]);
  let asked = 0;
  const fetchImpl = async (u) => (String(u).includes('ISO_week_date') ? new Response('', { status: 410 }) : gscFetch([])(u));
  const res = await refreshPages(cfg, L, [p], { today: '2026-11-10', rules: { strengthen: false }, chat: async () => { asked++; return answerChat(); }, fetchImpl });
  assert.equal(asked, 0);
  assert.equal(res.refreshed, 1);
  assert.deepEqual(p.refreshed.changes, ['gone source removed: https://en.wikipedia.org/wiki/ISO_week_date']);
});

test('a source fix the gate would refuse (too few sources left) leaves the page and says why', async () => {
  const { root, cfg, L, p } = pageSite();
  const before = fs.readFileSync(path.join(root, p.rel), 'utf8');
  const fetchImpl = async (u) => (String(u).includes('ISO_week_date') ? new Response('', { status: 410 }) : gscFetch([])(u));
  const res = await refreshPages(cfg, L, [p], { today: '2026-11-10', rules: { strengthen: false }, chat: answerChat, fetchImpl });
  assert.equal(res.refreshed, 0);
  assert.equal(fs.readFileSync(path.join(root, p.rel), 'utf8'), before);
  assert.match(p.refreshed.left.join(' '), /failed the gate/);
});
