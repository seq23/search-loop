// v1.16.0: comparison searches (her tip, 27 Nov 2026). One extra Search Console pull filtered by
// Search Console itself to "x vs y / alternatives / instead of / better than / switch from"; the
// free-model screen confirms each row is a comparison; confirmed rows are queued and built right
// after AI answer misses. The pull failing changes no other pick; a comparison page's claims about
// another company are sourced facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../bin/search-loop.mjs';
import { COMPARISON_REGEX } from '../src/gsc.mjs';
import { gateReport } from '../src/gate.mjs';
import { render, draftDrift } from '../src/render.mjs';
import { checkReport } from '../src/report.mjs';
import { fixtureConfig, fixtureDraft } from '../src/fixture.mjs';
import { site, fakeFetch, goodChat, distinctChat, NOW } from './harness.mjs';

const ledger = (root, f) => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop', f), 'utf8'));
const row = (q, position, impressions = 30, page = 'https://example.com/weekly-planning/') => ({ keys: [q, page], clicks: 0, impressions, position });

// A free model that answers the relevance screen: keeps every query and calls a query a comparison
// when the test says so (the real screen is a model reading meaning; this stands in for it).
const screenChat = ({ isComparison = () => false, isKept = () => true, comparisonKey = true, down = false, calls = [] } = {}) => {
  const draft = distinctChat();
  return async (args) => {
    const sys = args.messages[0].content;
    if (sys.startsWith('You screen search queries')) {
      calls.push(args.messages[1].content);
      if (down) return { ok: false, reason: 'HTTP 429 daily quota' };
      const lines = [...args.messages[1].content.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
      return { ok: true, answer: JSON.stringify({ keep: lines.filter(([, q]) => isKept(q)).map(([n]) => n), ...(comparisonKey ? { comparison: lines.filter(([, q]) => isComparison(q)).map(([n]) => n) } : {}) }) };
    }
    const r = await draft(args);
    if (/This search compares options/.test(args.messages[1].content)) {
      const d = JSON.parse(r.answer);
      d.rivals = [];
      return { ok: true, answer: JSON.stringify(d) };
    }
    return r;
  };
};

const NORMAL = [row('how to plan my week as a founder', 12, 40)];
const VS = 'weekly planning vs daily planning routine';
const ALT = 'alternatives to a paper weekly planning notebook';

test('the comparison pull asks Search Console for exactly the tip regex, as one extra query filter', async () => {
  const root = site();
  const bodies = [];
  await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, bodies }), chat: screenChat() });
  const filtered = bodies.filter((b) => b.dimensionFilterGroups?.[0]?.filters?.[0]?.operator === 'includingRegex');
  assert.equal(filtered.length, 1, 'one comparison pull per FIND');
  assert.deepEqual(filtered[0].dimensionFilterGroups, [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: COMPARISON_REGEX }] }]);
  assert.equal(COMPARISON_REGEX, String.raw`\b(vs|versus|compare|compared|comparing|comparisons?|alternatives?|competitors?|instead of|replacements?|better than|difference between|switch from|switching from)\b`);
  assert.deepEqual(filtered[0].dimensions, ['query', 'page']);
});

test('confirmed comparison searches lead the pick list and are built first; an unconfirmed regex row gets no priority', async () => {
  const root = site({ cfg: { find: { priority_topics: 1 } } });
  const cmpRows = [row(VS, 45, 12), row(ALT, 22, 8), row('weekly planning replacement pages refill', 18, 9)];
  // The model also calls an autocomplete-only search a comparison: only Search Console comparison rows get priority.
  const chat = screenChat({ isComparison: (q) => q === VS || q === ALT || q === 'weekly planning template' });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows }), chat });
  const t = ledger(root, 'targets.json').targets;
  assert.ok(t.some((x) => x.query === 'weekly planning template' && !x.comparison), 'autocomplete row the model called a comparison: no priority');
  const cmp = t.filter((x) => x.comparison).map((x) => x.query);
  assert.deepEqual(new Set(cmp), new Set([VS, ALT]), `comparison targets: ${cmp}`);
  // Comparisons first, before priority topics and everything else (no AI misses here).
  assert.deepEqual(new Set(t.slice(0, 2).map((x) => x.query)), new Set([VS, ALT]), `head of the list: ${t.slice(0, 4).map((x) => x.query)}`);
  assert.ok(t.some((x) => x.priority && !x.comparison), 'a priority target exists behind them');
  assert.match(t[0].reasons[0], /^comparison search: Search Console shows people choosing between options/);
  // The model said the "replacement pages refill" row is not a comparison: no priority.
  const refill = t.find((x) => x.query === 'weekly planning replacement pages refill');
  assert.ok(refill && !refill.comparison, 'regex-only row is not a comparison');
  // BUILD takes them first.
  const pages = ledger(root, 'pages.json').pages;
  assert.ok(pages.length >= 2, `published: ${r.report.notes.join(' | ')}`);
  assert.deepEqual(new Set(pages.slice(0, 2).map((p) => p.query)), new Set([VS, ALT]), `built first: ${pages.map((p) => p.query)}`);
  assert.ok(pages.slice(0, 2).every((p) => p.comparison === true));
  // Week report block.
  assert.equal(r.report.comparison.candidates, 3);
  assert.equal(r.report.comparison.confirmed, 2);
  assert.deepEqual(new Set(r.report.comparison.queued), new Set([VS, ALT]));
  assert.match(r.report.comparison.pulled, /^ok: 3 row/);
  assert.deepEqual(checkReport(r.report), []);
});

test('outage: the comparison pull failing leaves the normal pick unchanged and says "comparison pull: couldn\'t read"', async () => {
  const base = site();
  await run({ root: base, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [] }), chat: screenChat() });
  const down = site();
  const r = await run({ root: down, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpStatus: 500 }), chat: screenChat() });
  const q = (root) => ledger(root, 'targets.json').targets.map((x) => x.query);
  assert.ok(q(base).length > 0);
  assert.deepEqual(q(down), q(base), 'same targets in the same order');
  const rec = ledger(down, 'discovery-receipt.json');
  assert.match(rec.sources.comparison_pull, /^not read: comparison pull: couldn't read Search Console \(HTTP 500/);
  assert.match(rec.sources.search_console, /^ok: /, 'the normal pull still read');
  assert.ok(r.report.notes.some((n) => /comparison pull: couldn't read Search Console/.test(n)), `run notes: ${r.report.notes.join(' | ')}`);
  assert.match(r.report.comparison.pulled, /^not read: /);
  assert.equal(r.report.comparison.candidates, 0);
  assert.deepEqual(checkReport(r.report), []);
});

test('outage: with the free-model screen down, a comparison row is neither prioritised nor built unread', async () => {
  const root = site();
  const r = await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [row(VS, 45)] }), chat: screenChat({ down: true }) });
  const t = ledger(root, 'targets.json').targets;
  assert.ok(!t.some((x) => x.comparison), 'no comparison priority without the model');
  assert.ok(!t.some((x) => x.query === VS), 'a row only the comparison pull found is not queued unread');
  assert.match(String(r.report.comparison.confirmed), /^not read: free-model screen/);
  // The screen answering without its "comparison" list is not read either, never "0 comparisons".
  const root2 = site();
  const r2 = await run({ root: root2, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [row(VS, 45)] }), chat: screenChat({ comparisonKey: false }) });
  assert.ok(!ledger(root2, 'targets.json').targets.some((x) => x.comparison));
  assert.match(String(r2.report.comparison.confirmed), /^not read: the free model did not return "comparison"/);
});

test('dedupe: a comparison row the normal pull also has (and the same query on two pages) is one target', async () => {
  const root = site();
  const both = 'weekly planning vs daily planning for founders';
  const gscRows = [...NORMAL, row(both, 14, 25)];
  const cmpRows = [row(both, 14, 25), row(both, 19, 6, 'https://example.com/weekly-review/')];
  await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows, cmpRows }), chat: screenChat({ isComparison: (q) => q === both }) });
  const t = ledger(root, 'targets.json').targets.filter((x) => x.query === both || (x.variants || []).includes(both));
  assert.equal(t.length, 1, 'picked once');
  assert.equal(t[0].comparison, true);
  assert.equal(t[0].signals.gsc_position, 14, 'keeps the normal pull signal');
  assert.equal(t[0].signals.comparison_pull, true);
  assert.equal(t[0].signals.comparison_only, undefined, 'not marked as found by the comparison pull alone');
});

test('dedupe: a comparison row autocomplete also finds is one ordinary target when the screen is down', async () => {
  // Autocomplete answers seed "daily planning routine" with "daily planning routine template" (harness).
  const q = 'daily planning routine template';
  const root = site();
  await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [row(q, 44)] }), chat: screenChat({ down: true }) });
  const t = ledger(root, 'targets.json').targets.filter((x) => x.query === q);
  assert.equal(t.length, 1, 'still queued once: autocomplete found it too, so it is not a comparison-pull-only row');
  assert.ok(!t[0].comparison, 'no comparison priority without the model');
  assert.equal(t[0].signals.comparison_pull, true);
});

test('a comparison-pull row stands on the model\'s comparison read like a measured row; unconfirmed and unkept, it is not queued', async () => {
  const root = site();
  const other = 'weekly planning compared with a team standup notes';
  const cmpRows = [row(ALT, 44, 6), row(other, 52, 4)];
  // The model keeps neither (it reads both as about someone else's product), confirms ALT as a comparison.
  await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows }), chat: screenChat({ isKept: (q) => q !== ALT && q !== other, isComparison: (q) => q === ALT }) });
  const t = ledger(root, 'targets.json').targets;
  assert.equal(t[0].query, ALT);
  assert.equal(t[0].comparison, true);
  assert.ok(!t.some((x) => x.query === other), 'neither kept nor a comparison nor measured in the window: not queued');
});

test('a site with 0 comparison searches: the normal pick, an honest 0, a valid report', async () => {
  const root = site();
  const r = await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [] }), chat: screenChat() });
  const t = ledger(root, 'targets.json').targets;
  assert.ok(t.length > 0);
  assert.ok(!t.some((x) => x.comparison));
  assert.deepEqual(r.report.comparison, { pulled: 'ok: 0 row(s)', candidates: 0, confirmed: 0, queued: [] });
  assert.deepEqual(checkReport(r.report), []);
  assert.ok(checkReport({ ...r.report, comparison: { pulled: 'ok', candidates: 'many' } }).some((p) => p.startsWith('comparison must be')));
  assert.ok(checkReport({ ...r.report, comparison: '' }).some((p) => p.startsWith('comparison must be')), 'an empty block is not a pass');
});

test('a comparison row the site already ranks top for is left alone', async () => {
  const root = site();
  const r = await run({ root, now: NOW, stage: 'find', 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [row(VS, 3)] }), chat: screenChat({ isComparison: () => true }) });
  assert.ok(!ledger(root, 'targets.json').targets.some((x) => x.query === VS));
  assert.match(r.report.comparison.pulled, /1 already above position 8, left alone/);
});

// --- the page: claims about another company are sourced facts -------------------------------
const RIVAL = 'Notion';
const gateOf = (mut, page = {}) => {
  const cfg = fixtureConfig();
  const d = fixtureDraft();
  d.facts = [
    { claim: 'Notion offers a free plan for individuals with unlimited pages and blocks.', source_url: 'https://www.notion.com/pricing', source_name: 'Notion', verified: true },
    ...d.facts.map((f) => ({ ...f, verified: true })),
  ];
  d.rivals = [RIVAL];
  mut(d);
  const html = render(cfg, { slug: 'example-planner-vs-notion', draft: d, related: [{ route: '/weekly-review/', anchor: 'How to run a weekly review' }], published: '2026-11-02' });
  return gateReport({ query: 'example planner vs notion', html, facts: d.facts, comparison: true, rivals: d.rivals, ...page }, { cfg, corpus: [], siblings: [] }).problems.filter((p) => p.startsWith('rivals:'));
};

test('gate: a comparison page passes when every sentence about the rival repeats a sourced fact', () => {
  assert.deepEqual(gateOf((d) => { d.sections[0].heading = 'Example Planner vs Notion: which fits a weekly plan?'; d.sections[0].paragraphs[0] += ' Notion offers a free plan for individuals with unlimited pages and blocks.'; }), []);
});

test('gate: an unsourced sentence about the rival blocks the page', () => {
  const p = gateOf((d) => { d.sections[1].paragraphs[0] += ' Notion is slow and hard to set up for a weekly plan.'; });
  assert.equal(p.length, 1, p.join(' | '));
  assert.match(p[0], /^rivals: "Notion is slow and hard to set up for a weekly plan\." says something about Notion with no source/);
  // in a bullet and an FAQ answer too
  assert.equal(gateOf((d) => { d.sections[0].bullets = ['Notion lacks a weekly review view', ...d.sections[0].bullets]; }).length, 1);
  assert.equal(gateOf((d) => { d.faq[0].a += ' Notion costs more for teams.'; }).length, 1);
});

test('gate: a rival named in no verified fact blocks; a failed source does not count', () => {
  assert.match(gateOf((d) => { d.rivals = ['Todoist']; })[0], /nothing the page says about "Todoist" is a verified fact/);
  assert.match(gateOf((d) => { d.facts[0].verified = false; })[0], /nothing the page says about "Notion" is a verified fact/);
});

test('gate: a comparison draft with no rivals list is refused (fails closed); a non-comparison page is not checked', () => {
  assert.match(gateOf(() => {}, { rivals: undefined })[0], /must list in "rivals"/);
  assert.deepEqual(gateOf((d) => { d.sections[1].paragraphs[0] += ' Notion is slow.'; }, { comparison: false }), []);
  assert.deepEqual(gateOf((d) => { d.rivals = []; }), [], 'two methods, no company: nothing to source');
});

test('the draft prompt for a comparison asks for rivals, sources and skip; a normal search gets none of it', async () => {
  const { draftPrompt, cleanDraft } = await import('../src/build.mjs');
  const cfg = fixtureConfig();
  const p = draftPrompt(cfg, { query: 'example planner vs notion', comparison: true }, [], null)[1].content;
  assert.match(p, /This search compares options/);
  assert.match(p, /"rivals": \[/);
  assert.match(p, /an unsourced sentence about a rival stops it from being published/);
  assert.match(p, /Something about a rival you cannot source is left out/);
  assert.match(p, /the direct answer defines the choice in your own words without naming a rival/);
  assert.match(p, /never imply Example Planner is affiliated with or endorsed by one/);
  const n = draftPrompt(cfg, { query: 'how to plan my week' }, [], null)[1].content;
  assert.doesNotMatch(n, /compares options|"rivals"/);
  const d = cleanDraft({ ...fixtureDraft(), rivals: ['Notion', ' Notion ', '', 'Todoist'] });
  assert.deepEqual(d.rivals, ['Notion', 'Todoist']);
  assert.equal('rivals' in cleanDraft(fixtureDraft()), false);
});

// --- the comparison table (ship-ready search d2: a table for any comparison) ------------------
const TABLE = { columns: ['If you need', 'Look for', 'Where to check'], rows: [['Coaching between sessions', 'Daily check-ins you can answer in two minutes', 'The product tour'], ['A human coach', 'Named coaches and session limits', 'The plan page']] };
const pageOf = (mut) => {
  const cfg = fixtureConfig();
  const d = fixtureDraft();
  d.facts = [
    { claim: 'Notion offers a free plan for individuals with unlimited pages and blocks.', source_url: 'https://www.notion.com/pricing', source_name: 'Notion', verified: true },
    ...d.facts.map((f) => ({ ...f, verified: true })),
  ];
  d.rivals = [RIVAL];
  d.sections[2].table = JSON.parse(JSON.stringify(TABLE));
  mut(d);
  const html = render(cfg, { slug: 'example-planner-vs-notion', draft: d, related: [], published: '2026-11-02' });
  return { d, html, r: gateReport({ query: 'example planner vs notion', html, facts: d.facts, comparison: true, rivals: d.rivals }, { cfg, corpus: [], siblings: [] }) };
};

test('a comparison table renders as a real table, survives the drift check, and a ragged one is dropped', async () => {
  const { cleanDraft } = await import('../src/build.mjs');
  const { d, html, r } = pageOf(() => {});
  assert.match(html, /<div class="table-scroll" style="overflow-x:auto"><table><thead><tr><th scope="col">If you need<\/th>/);
  assert.match(html, /<tr><th scope="row">A human coach<\/th><td>Named coaches and session limits<\/td>/);
  assert.deepEqual(r.problems.filter((x) => x.startsWith('rivals:')), []);
  assert.ok(!r.notes.some((n) => n.startsWith('d2 a comparison page')), 'no table note when the table is there');
  assert.deepEqual(draftDrift(html, d), [], 'table cells count as the draft\'s own words');
  assert.ok(draftDrift(html.replace('Named coaches and session limits', 'Edited by hand'), d).length > 0, 'a hand-edited cell is drift');
  const kept = cleanDraft({ ...fixtureDraft(), sections: [{ heading: 'How to choose', paragraphs: ['x'], table: TABLE }] });
  assert.deepEqual(kept.sections[0].table, TABLE);
  const ragged = cleanDraft({ ...fixtureDraft(), sections: [{ heading: 'How to choose', paragraphs: ['x'], table: { columns: ['a', 'b'], rows: [['1', '2'], ['3']] } }] });
  assert.equal('table' in ragged.sections[0], false);
  const { r: noTable } = pageOf((x) => { delete x.sections[2].table; });
  assert.ok(noTable.notes.some((n) => n.startsWith('d2 a comparison page reads best with a table')));
  assert.ok(!noTable.problems.some((n) => n.startsWith('d2')), 'a missing table is a note, never a block');
});

test('gate: a table row or column about the rival is a claim and blocks unsourced', () => {
  const row = pageOf((d) => { d.sections[2].table.rows.push(['Notion', 'No weekly review view', 'Its help centre']); }).r.problems.filter((x) => x.startsWith('rivals:'));
  assert.equal(row.length, 1, row.join(' | '));
  assert.match(row[0], /the table cell "No weekly review view" states something about Notion with no source/);
  const col = pageOf((d) => { d.sections[2].table = { columns: ['What matters', 'Notion', 'Example Planner'], rows: [['Price', 'Free for one person', 'One payment'], ['Reviews', 'Build your own', 'Built in']] }; }).r.problems.filter((x) => x.startsWith('rivals:'));
  assert.equal(col.length, 1, col.join(' | '));
  assert.match(col[0], /the table cell "Free for one person" states something about Notion/);
});

test('a fact about a rival counts only when its source page names that rival', async () => {
  const { verifyFacts } = await import('../src/build.mjs');
  const pages = { 'https://a.example/second-nature': '<html><title>Second Nature: AI sales role-play</title>' + 'x'.repeat(600) + '</html>', 'https://b.example/diet': '<html><title>A diet app</title>' + 'y'.repeat(600) + '</html>' };
  const fetchImpl = async (u) => new Response(pages[u] || '', { status: pages[u] ? 200 : 404 });
  const facts = [
    { claim: 'Second Nature offers AI role-play practice for sales teams.', source_url: 'https://a.example/second-nature' },
    { claim: 'Second Nature is a weight-loss programme.', source_url: 'https://b.example/diet' },
    { claim: 'Coaching works best with a weekly review.', source_url: 'https://b.example/diet' },
  ];
  const out = await verifyFacts(facts, fetchImpl, ['Second Nature']);
  assert.deepEqual(out.map((f) => f.verified), [true, false, true]);
  assert.equal(out[1].unnamed, 'Second Nature');
  // a normal page (no rivals) is checked exactly as before
  const plain = await verifyFacts([{ claim: 'Second Nature is a weight-loss programme.', source_url: 'https://b.example/diet' }], fetchImpl);
  assert.equal(plain[0].verified, true);
  // the fix pass is told why
  const { r } = pageOf((d) => { d.facts[0] = { ...d.facts[0], verified: false, checked_status: 200, unnamed: 'Notion' }; d.facts = [d.facts[0], d.facts[1]]; });
  assert.ok(r.problems.some((p) => p.includes('the page never names Notion, so it is no source for a claim about it')), r.problems.join(' | '));
});
