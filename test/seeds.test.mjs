// v1.17.0: hand-given searches (config `seeds`, her yes 27 Nov 2026: "yes turn those searches
// into pages") and the product's own facts (config `product`). A seed goes through every check a
// found search goes through, is built right after comparison searches and before priority
// topics, strengthens a live engine page with its intent instead of making a second page, and a
// page never says the product has a feature its facts do not state (a model reads the claims).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../bin/search-loop.mjs';
import { checkReport } from '../src/report.mjs';
import { checkConfig } from '../src/config.mjs';
import { productClaims } from '../src/product.mjs';
import { FIXTURE_CONFIG_RAW, fixtureConfig } from '../src/fixture.mjs';
import { site, fakeFetch, distinctChat, NOW } from './harness.mjs';

const ledger = (root, f) => JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop', f), 'utf8'));
const row = (q, position, impressions = 30, page = 'https://example.com/weekly-planning/') => ({ keys: [q, page], clicks: 0, impressions, position });
const PRODUCT = { facts: ['Example Planner is a weekly planning notebook app for founders.', 'Example Planner needs no account.'], lacks: ['Example Planner does not work offline.'] };
const SEED = 'weekly planning app with no account';
const VS = 'weekly planning vs daily planning routine';
const NORMAL = [row('how to plan my week as a founder', 12, 40)];

// One fake free model for every call the engine makes: the relevance screen, the product-claim
// check, strengthen, and drafts. `claim` decides whether a sentence about the product is supported.
function chatFor({ screenDown = false, claimsDown = false, isComparison = () => false, isKept = () => true, sayOffline = false, claim = (s) => !/offline/i.test(s), calls = { screen: 0, claims: 0, drafts: [], strengthen: 0 } } = {}) {
  const draft = distinctChat();
  return Object.assign(async (args) => {
    const sys = args.messages[0].content;
    const user = args.messages[1].content;
    if (sys.startsWith('You screen search queries')) {
      calls.screen++;
      if (screenDown) return { ok: false, reason: 'HTTP 429 daily quota' };
      const lines = [...user.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);
      return { ok: true, answer: JSON.stringify({ keep: lines.filter(([, q]) => isKept(q)).map(([n]) => n), comparison: lines.filter(([, q]) => isComparison(q)).map(([n]) => n) }) };
    }
    if (sys.startsWith('You check one web page against the facts')) {
      calls.claims++;
      if (claimsDown) return { ok: false, reason: 'HTTP 429 daily quota' };
      const text = user.split('Page text:\n')[1].split('\n\nList EVERY')[0];
      const sentences = text.split(/(?<=[.!?])\s+|\n/).filter((s) => /Example Planner/.test(s));
      return { ok: true, answer: JSON.stringify({ claims: sentences.map((s) => ({ sentence: s, supported: claim(s), why: claim(s) ? 'fact 1' : 'fact list says it does not work offline' })) }) };
    }
    if (sys.startsWith('You improve one page')) {
      calls.strengthen++;
      return { ok: true, answer: JSON.stringify({ sections: [{ heading: 'Can you plan the week without making an account?', paragraphs: [`Example Planner needs no account. ${'You open it and start the week with one short list of the outcomes that matter most to you. '.repeat(6)}`] }], faq: [{ q: 'Do I need an account to start planning?', a: 'No. Example Planner needs no account, so you open it and write the first list of the week straight away, with nothing to sign up for before you start. You can keep the same short list all week and change it on Sunday night when the next week begins.' }] }) };
    }
    const r = await draft(args);
    const d = JSON.parse(r.answer);
    calls.drafts.push(user.match(/Search to answer: "([^"]+)"/)?.[1]);
    if (/This search compares options/.test(user)) d.rivals = [];
    // Every page says one true thing about the product; a bad draft also claims a missing feature.
    d.sections[0].paragraphs[0] = `Example Planner needs no account. ${d.sections[0].paragraphs[0]}`;
    if (sayOffline) d.sections[1].paragraphs[0] = `Example Planner works offline on a plane. ${d.sections[1].paragraphs[0]}`;
    return { ok: true, answer: JSON.stringify(d) };
  }, { calls });
}

test('config: seeds need product facts; a bad seed or product list is named', () => {
  const base = { ...FIXTURE_CONFIG_RAW };
  assert.deepEqual(checkConfig({ ...base, seeds: [SEED], product: PRODUCT }), []);
  assert.ok(checkConfig({ ...base, seeds: [SEED] }).some((p) => /^seeds need product\.facts/.test(p)));
  assert.ok(checkConfig({ ...base, seeds: ['one'], product: PRODUCT }).some((p) => /^seeds\[0\]: a search of 2-14 words/.test(p)));
  assert.ok(checkConfig({ ...base, seeds: [{ query: SEED, wants: 'no account' }], product: PRODUCT }).some((p) => /^seeds\[0\]\.wants/.test(p)));
  assert.ok(checkConfig({ ...base, product: { facts: [] } }).some((p) => /^product\.facts/.test(p)));
  assert.ok(checkConfig({ ...base, seeds: Array.from({ length: 26 }, (_, i) => `weekly planning seed number ${i}`), product: PRODUCT }).some((p) => /at most 25/.test(p)));
});

test('a seed is picked right after comparison searches and before priority topics, and built in that order', async () => {
  const root = site({ cfg: { find: { priority_topics: 1 }, seeds: [{ query: SEED, wants: ['no account', 'offline'] }], product: PRODUCT } });
  const chat = chatFor({ isComparison: (q) => q === VS });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL, cmpRows: [row(VS, 45, 12)] }), chat });
  const t = ledger(root, 'targets.json').targets;
  assert.equal(t[0].query, VS, `head: ${t.slice(0, 3).map((x) => x.query)}`);
  assert.equal(t[1].query, SEED, `second: ${t.slice(0, 3).map((x) => x.query)}`);
  assert.ok(t[1].signals.seed && !t[1].comparison);
  assert.match(t[1].reasons[0], /^hand-given search \(config seeds\)/);
  assert.ok(t[2].priority, `third is a priority topic: ${JSON.stringify(t[2].query)}`);
  const pages = ledger(root, 'pages.json').pages;
  assert.deepEqual(pages.slice(0, 2).map((p) => p.query), [VS, SEED], `built: ${pages.map((p) => p.query)} | ${r.report.notes.join(' | ')}`);
  assert.equal(pages[1].seed, true);
  // The writer was told what the product is, what it lacks, and what the searcher asked for.
  const seedPrompt = chat.calls.drafts.indexOf(SEED);
  assert.ok(seedPrompt >= 0);
  // The ledger and the week report say it was built, at its URL.
  const s = Object.values(ledger(root, 'seeds.json').seeds);
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'built');
  assert.equal(s[0].url, pages[1].url);
  assert.deepEqual(r.report.seeds.built.map((x) => x.query), [SEED]);
  assert.deepEqual(checkReport(r.report), []);
  assert.match(r.census, /seeds=1\/built:1\/strengthened:0\/answered:0\/refused:0\/queued:0/);
  assert.ok(chat.calls.claims >= 2, 'every new page is read against the product facts');
});

test('the draft prompt carries the product facts, what it lacks and the wants', async () => {
  const root = site({ cfg: { seeds: [{ query: SEED, wants: ['no account', 'offline'] }], product: PRODUCT } });
  const prompts = [];
  const inner = chatFor();
  const chat = async (args) => { if (/Search to answer: "weekly planning app with no account"/.test(args.messages[1]?.content || '')) prompts.push(args.messages[1].content); return inner(args); };
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat });
  assert.ok(prompts.length >= 1);
  assert.match(prompts[0], /These are the ONLY things the page may say about Example Planner[\s\S]*Example Planner needs no account\./);
  assert.match(prompts[0], /does NOT do or have \(never say or imply it does\):\s*\n- Example Planner does not work offline\./);
  assert.match(prompts[0], /The person searching asked for: no account, offline\./);
  assert.match(prompts[0], /This search compares options/, 'a seed gets the sourced-rival rules');
});

test('seeds pass the same checks as found searches: an excluded word and a screen "no" are refused with the reason', async () => {
  const bad = 'weekly planning spreadsheet for teams';
  const off = 'weekly planning app for dog walkers';
  const root = site({ cfg: { find: { exclude_words: ['spreadsheet'] }, seeds: [SEED, bad, off], product: PRODUCT } });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor({ isKept: (q) => q !== off }) });
  const book = ledger(root, 'seeds.json').seeds;
  const by = (q) => Object.values(book).find((x) => x.query === q);
  assert.equal(by(bad).status, 'refused');
  assert.match(by(bad).reason, /find\.exclude_words/);
  assert.equal(by(off).status, 'refused');
  assert.match(by(off).reason, /relevance screen kept it off/);
  assert.equal(by(SEED).status, 'built');
  const targets = ledger(root, 'targets.json').targets.map((x) => x.query);
  assert.ok(!targets.includes(bad) && !targets.includes(off));
  assert.deepEqual(new Set(r.report.seeds.refused.map((x) => x.query)), new Set([bad, off]));
  assert.deepEqual(checkReport(r.report), []);
});

test('a page that claims a feature the product lacks is never published (the product-claim check stops it)', async () => {
  const root = site({ cfg: { seeds: [SEED], product: PRODUCT } });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor({ sayOffline: true }) });
  const book = ledger(root, 'pages.json');
  assert.equal(book.pages.length, 0, `published: ${book.pages.map((p) => p.query)}`);
  const drop = book.dropped.find((d) => d.query === SEED);
  assert.ok(drop, 'the seed is dropped by the gate');
  assert.ok(drop.reason.some((x) => /^product claim: "Example Planner works offline on a plane\." is not in the site's product facts/.test(x)), JSON.stringify(drop.reason));
  const s = Object.values(ledger(root, 'seeds.json').seeds)[0];
  assert.equal(s.status, 'queued');
  assert.match(s.reason, /dropped by the page gate, tried again later: product claim/);
  assert.equal(r.report.seeds.queued.length, 1);
});

test('outage: the product-claim check down = no page, nothing dropped, the seed stays queued; never a pass', async () => {
  const root = site({ cfg: { seeds: [SEED], product: PRODUCT } });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor({ claimsDown: true }) });
  const book = ledger(root, 'pages.json');
  assert.equal(book.pages.length, 0, 'no page is written unread');
  assert.equal(book.dropped.length, 0, 'an outage is not a drop');
  assert.ok(!fs.existsSync(path.join(root, 'questions', 'weekly-planning-app-with-no-account')));
  const s = Object.values(ledger(root, 'seeds.json').seeds)[0];
  assert.equal(s.status, 'queued');
  assert.match(s.reason, /product-claim check: no free model answered/);
  assert.ok(r.report.notes.some((n) => /stays queued for the next run/.test(n)));
});

test('outage: the relevance screen down = no seed page this run, queued with the reason', async () => {
  const root = site({ cfg: { seeds: [SEED], product: PRODUCT } });
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor({ screenDown: true }) });
  assert.ok(!ledger(root, 'targets.json').targets.some((x) => x.query === SEED));
  assert.ok(!ledger(root, 'pages.json').pages.some((p) => p.query === SEED));
  const s = Object.values(ledger(root, 'seeds.json').seeds)[0];
  assert.equal(s.status, 'queued');
  assert.match(s.reason, /relevance screen was not read/);
  assert.deepEqual(checkReport(r.report), []);
});

test('productClaims: a model that lists no claim on a page naming the product is not read, never a pass', async () => {
  const cfg = { ...fixtureConfig('/tmp/x'), product: PRODUCT };
  const d = { h1: 'Planning apps', direct_answer: 'Example Planner needs no account.', sections: [], faq: [], facts: [] };
  const empty = await productClaims(cfg, d, { chat: async () => ({ ok: true, answer: '{"claims":[]}' }) });
  assert.equal(empty.ok, false);
  assert.match(empty.notRead, /listed no claim, but the page names Example Planner/);
  const junk = await productClaims(cfg, d, { chat: async () => ({ ok: true, answer: 'sure, looks fine' }) });
  assert.equal(junk.ok, false);
  const bad = await productClaims(cfg, d, { chat: async () => ({ ok: true, answer: '{"claims":[{"sentence":"Example Planner syncs to iCloud.","supported":false,"why":"not a fact"}]}' }) });
  assert.equal(bad.ok, true);
  assert.equal(bad.problems.length, 1);
});

test('a seed with the intent of a live engine page strengthens that page (no second page); one a hand-built page answers is recorded there', async () => {
  const root = site({ cfg: { product: PRODUCT } });
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor() });
  const first = ledger(root, 'pages.json').pages;
  assert.ok(first.length >= 1);
  const target = first[0];
  const cfgPath = path.join(root, 'search-loop.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.seeds = [target.query, 'weekly planning for founders'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const later = new Date(NOW.getTime() + 8 * 86400e3);
  const chat = chatFor();
  const r = await run({ root, now: later, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat });
  const pages = ledger(root, 'pages.json').pages;
  assert.equal(pages.filter((p) => p.query === target.query).length, 1, 'no second page for the same intent');
  const book = Object.values(ledger(root, 'seeds.json').seeds);
  const s = book.find((x) => x.query === target.query);
  assert.equal(s.status, 'strengthened', JSON.stringify(s));
  assert.equal(s.url, target.url);
  const p = pages.find((x) => x.slug === target.slug);
  assert.equal(p.strengthen.trigger, 'seed');
  assert.ok(chat.calls.strengthen >= 1);
  assert.ok(fs.readFileSync(path.join(root, p.rel), 'utf8').includes('Can you plan the week without making an account?'));
  const hand = book.find((x) => x.query === 'weekly planning for founders');
  assert.equal(hand.status, 'answered_by');
  assert.equal(hand.url, 'https://example.com/weekly-planning/');
  assert.deepEqual(r.report.seeds.strengthened.map((x) => x.query), [target.query]);
  assert.deepEqual(r.report.seeds.answered_by.map((x) => x.query), ['weekly planning for founders']);
  assert.deepEqual(checkReport(r.report), []);
  // Done seeds are not asked again: a third run makes no new seed action.
  const again = chatFor();
  await run({ root, now: new Date(later.getTime() + 8 * 86400e3), 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: again });
  assert.equal(again.calls.strengthen, 0, 'a strengthened seed is not strengthened again');
});

test('the week report seeds block counts every configured seed exactly once, and says "not read" with no seeds', async () => {
  const root = site();
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: NORMAL }), chat: chatFor() });
  assert.match(r.report.seeds, /^not read: this site has no seeds/);
  assert.match(r.census, / seeds=none /);
  assert.deepEqual(checkReport({ ...r.report, seeds: { configured: 2, built: [], strengthened: [], answered_by: [], refused: [], queued: [{ query: 'x', reason: 'y' }] } }).filter((p) => /seeds/.test(p)).length, 1);
});
