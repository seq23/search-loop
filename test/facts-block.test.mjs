// v1.13.0: the sourced facts sit under a heading the model writes (p-n-p #223 review
// sr_mwrbmeq6vzb3); an older draft with none keeps its sources below the FAQ under "Sources".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateReport } from '../src/gate.mjs';
import { render } from '../src/render.mjs';
import { cleanDraft } from '../src/build.mjs';
import { fixtureConfig, fixtureDraft } from '../src/fixture.mjs';

const page = (d) => render(fixtureConfig(), { slug: 'x', draft: d, related: [], published: '2026-11-01' });
const h2s = (html) => [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);

test('facts block: the model-written heading is used, in place, with each source link small', () => {
  const d = fixtureDraft();
  const html = page(d);
  const heads = h2s(html);
  assert.ok(heads.includes(d.facts_heading));
  assert.ok(heads.indexOf(d.facts_heading) < heads.indexOf('Frequently asked questions'));
  assert.ok(!html.includes('What the sources say'));
  for (const f of d.facts) assert.ok(html.includes(`${f.claim} <small>(<a href="${f.source_url}"`));
  // The gate still finds and accepts the sourced lines.
  const { problems } = gateReport({ query: 'how to plan your week as a founder', html, facts: d.facts }, { cfg: fixtureConfig(), corpus: [], siblings: [] });
  assert.deepEqual(problems.filter((p) => /^facts:/.test(p)), []);
});

test('facts block: a draft with no heading keeps its sources, below the FAQ, under a plain label', () => {
  const d = fixtureDraft(); delete d.facts_heading;
  const heads = h2s(page(d));
  assert.equal(heads.at(-1), 'Sources');
  assert.ok(heads.indexOf('Sources') > heads.indexOf('Frequently asked questions'));
});

test('facts block: cleanDraft carries the heading; no verified facts, no block', () => {
  const d = fixtureDraft();
  assert.equal(cleanDraft({ ...d, facts_heading: '  How the weeks are counted ' }).facts_heading, 'How the weeks are counted');
  assert.ok(!page({ ...d, facts: d.facts.map((f) => ({ ...f, verified: false })) }).includes('data-search-loop="facts"'));
});
