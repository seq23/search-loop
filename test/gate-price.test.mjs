// v1.12.1: a money amount in the page's prose is a price claim and must be sourced (risk brain
// R-ADV-13). The site's own offer (the action label the template writes, gate.own_prices) is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateReport } from '../src/gate.mjs';
import { render } from '../src/render.mjs';
import { fixtureConfig, fixtureDraft } from '../src/fixture.mjs';
import { checkConfig } from '../src/config.mjs';
import { FIXTURE_CONFIG_RAW } from '../src/fixture.mjs';

const priceProblems = (cfg, mut) => {
  const d = fixtureDraft(); mut(d);
  const html = render(cfg, { slug: 'x', draft: d, related: [{ route: '/weekly-review/', anchor: 'How to run a weekly review' }], published: '2026-11-01' });
  return gateReport({ query: 'how to plan your week as a founder', html, facts: d.facts }, { cfg, corpus: [], siblings: [] }).problems.filter((p) => /unsourced price/.test(p));
};

test('gate: an unsourced price fails, a sourced one and the site\'s own price pass', () => {
  const cfg = fixtureConfig();
  // The live approvalprep.com sentence (16 Nov 2026), spelled out.
  const words = priceProblems(cfg, (d) => { d.sections[0].paragraphs[0] += ' Companies charge setup fees ranging from nineteen to ninety-nine dollars followed by monthly subscription charges spanning sixty to one hundred fifty dollars.'; });
  assert.equal(words.length, 1, 'spelled-out dollars are caught');
  assert.match(words[0], /drop the amount, or move it into "facts"/, 'the fix pass is told how to fix it');
  for (const s of ['It costs $19 to start.', 'Plans run USD 60 a month.', 'Some charge $1,200/month.', 'Expect 99 dollars up front.']) {
    assert.equal(priceProblems(cfg, (d) => { d.sections[0].paragraphs[0] += ` ${s}`; }).length, 1, `caught: ${s}`);
  }
  // Sourced: the sentence carries a verified fact.
  const claim = 'One national company lists a $79.99 monthly fee on its pricing page.';
  assert.deepEqual(priceProblems(cfg, (d) => { d.facts.push({ claim, source_url: 'https://example.org/pricing', source_name: 'Example', verified: true }); d.sections[0].paragraphs[0] += ` ${claim}`; }), []);
  // Same sentence with the fact unverified fails (negative proof of the sourced path).
  assert.equal(priceProblems(cfg, (d) => { d.facts.push({ claim, source_url: 'https://example.org/pricing', verified: false }); d.sections[0].paragraphs[0] += ` ${claim}`; }).length, 1);
  // The site's own CTA price in the action label the template writes.
  const own = { ...cfg, action: { ...cfg.action, label: 'Draft your dispute letter free, or get the DIY Credit Letter Kit ($19 once)' } };
  assert.deepEqual(priceProblems(own, () => {}), []);
  // Own offer text in the prose passes only when declared in gate.own_prices.
  const mention = (d) => { d.sections[1].paragraphs[0] += ' The DIY Credit Letter Kit ($19 once) has every letter.'; };
  assert.equal(priceProblems(own, mention).length, 1);
  assert.deepEqual(priceProblems({ ...own, gate: { own_prices: ['DIY Credit Letter Kit ($19 once)'] } }, mention), []);
  assert.ok(checkConfig({ ...FIXTURE_CONFIG_RAW, gate: { own_prices: [5] } }).some((x) => /own_prices/.test(x)));
});
