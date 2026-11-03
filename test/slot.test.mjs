import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftSlot, draftWords, slotProblems } from '../src/slot.mjs';
import { FIXTURE_CONFIG_RAW, fixtureDraft } from '../src/fixture.mjs';
import { render } from '../src/render.mjs';
import { corpusFor, matchIntent } from '../src/distinct.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = { ...FIXTURE_CONFIG_RAW, output: { dir: 'questions', format: 'dir-index', url_prefix: '/questions/' } };
const fetchOk = async () => new Response('<html>' + 'x'.repeat(1000) + '</html>', { status: 200 });
const longDraft = (mut = (d) => d) => {
  const d = fixtureDraft();
  d.sections = [...d.sections, ...d.sections.map((s) => ({ ...s, heading: s.heading.replace('?', ' this month?') }))];
  d.facts = [1, 2, 3].map((n) => ({ claim: `Fact ${n} about planning.`, source_url: `https://en.wikipedia.org/wiki/Planning_${n}`, source_name: 'Wikipedia' }));
  return mut(JSON.parse(JSON.stringify(d).replace(/\b(I|me|my|mine|myself)\b/g, 'you')));
};
const chatWith = (drafts, seen = []) => async ({ messages }) => { seen.push(messages[1].content); const d = drafts.shift(); return { ok: true, answer: JSON.stringify(d), model: 'fake/free' }; };
const slot = { title: 'How do you plan your week as a busy founder?', kind: 'insight', words: [1500, 2200] };

test('draft-slot returns the material for an approved title, kept unchanged, without writing anything', async () => {
  const d = longDraft();
  assert.ok(draftWords(d) >= 800, `fixture is ${draftWords(d)} words`);
  const r = await draftSlot(cfg, { ...slot, title: 'Approved Title: Kept' }, { chat: chatWith([d]), fetchImpl: fetchOk });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.draft.h1, 'Approved Title: Kept');
  assert.ok(r.draft.faq.length >= 3 && r.draft.facts.every((f) => f.verified));
});

test('draft-slot sends first person and the site check problems back to the model, then accepts the fix', async () => {
  const bad = longDraft((d) => { d.sections[0].paragraphs[0] = 'In my practice I see this often. ' + d.sections[0].paragraphs[0]; return d; });
  const seen = [];
  let checks = 0;
  const r = await draftSlot(cfg, slot, { chat: chatWith([bad, longDraft(), longDraft()], seen), fetchImpl: fetchOk, check: () => (++checks === 1 ? ['shares 41% of its text with /resources/x/'] : []) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.match(seen[1], /first person/);
  assert.match(seen[2], /shares 41%/);
});

test('draft-slot refuses a thin piece and names the stop when every attempt fails', async () => {
  const thin = () => { const d = fixtureDraft(); d.sections = d.sections.slice(0, 1); return d; };
  const r = await draftSlot(cfg, slot, { chat: chatWith([thin(), thin(), thin()]), fetchImpl: fetchOk });
  assert.equal(r.ok, false);
  assert.equal(r.stop, 'SLOT_DRAFT_REJECTED');
  assert.match(r.reason, /words/);
  assert.ok(slotProblems(longDraft(), { ...slot, avoid: { headings: ['What should a weekly plan include?'] } }).some((p) => /headings already used/.test(p)));
});

test('reserved_titles: a scheduled calendar title blocks a question page on the same intent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-res-'));
  fs.writeFileSync(path.join(root, 'reserved.json'), JSON.stringify([{ route: '/resources/insights/plan-week-founder/', title: 'How to plan your week as a busy founder' }]));
  const c = { ...cfg, root, reserved_titles: 'reserved.json' };
  const m = matchIntent(c, 'plan your week as a busy founder', corpusFor(c, [], { pages: [] }));
  assert.ok(m, 'expected the reserved title to match');
  assert.equal(m.kind, 'reserved');
  assert.equal(matchIntent({ ...cfg, root }, 'plan your week as a busy founder', corpusFor({ ...cfg, root }, [], { pages: [] })), null);
});

test('author: question pages show the person as the visible byline with Person schema', () => {
  const html = render({ ...cfg, author: { name: 'Pat Example, LCSW', url: 'https://example.com/about/' } }, { slug: 'plan-week', draft: { ...fixtureDraft(), facts: [] }, published: '2026-11-03' });
  assert.match(html, /By <a href="https:\/\/example.com\/about\/">Pat Example, LCSW<\/a>/);
  assert.match(html, /"author":\{"@type":"Person","name":"Pat Example, LCSW"/);
  const plain = render(cfg, { slug: 'plan-week', draft: { ...fixtureDraft(), facts: [] }, published: '2026-11-03' });
  assert.doesNotMatch(plain, /"@type":"Person"/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg-'));
  fs.writeFileSync(path.join(root, 'c.json'), JSON.stringify({ ...FIXTURE_CONFIG_RAW, author: { name: '' } }));
  assert.ok(loadConfig('c.json', root).problems.some((p) => /author/.test(p)));
});

test('local.substance reaches the prompt only for a search that names one of the places', async () => {
  const { draftPrompt } = await import('../src/build.mjs');
  const c = { ...cfg, local: { city: 'Memphis', neighbourhoods: ['Germantown'], substance: 'Name nearby communities and local crisis resources with sources.' } };
  assert.match(draftPrompt(c, { query: 'virtual therapy germantown tn' }, [], null)[1].content, /local page for Germantown\. Name nearby communities/);
  assert.doesNotMatch(draftPrompt(c, { query: 'therapy vs coaching' }, [], null)[1].content, /local page/);
});

test('distinct.near_dup tightens the near-duplicate gate between question pages', async () => {
  const { gateReport } = await import('../src/gate.mjs');
  const { shingles, stripTags } = await import('../src/util.mjs');
  const html = render(cfg, { slug: 'plan-week', draft: { ...fixtureDraft(), facts: [] }, published: '2026-11-03' });
  const quarter = new Set([...shingles(stripTags(html))].filter((_, i) => i % 4 === 0)); // shares about a quarter
  const ctx = (c) => ({ cfg: c, corpus: [{ route: '/other/', sh: quarter }], siblings: [], selfRoute: '/questions/plan-week/' });
  const dup = (c) => gateReport({ query: 'plan week', html, facts: [] }, ctx(c)).problems.some((p) => /near-duplicate/.test(p));
  assert.equal(dup(cfg), false);
  assert.equal(dup({ ...cfg, distinct: { near_dup: 0.01 } }), true);
  assert.equal(dup({ ...cfg, distinct: { near_dup: 0.9 } }), false, 'a looser setting never loosens the default');
});
