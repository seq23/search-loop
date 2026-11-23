// v1.15.0 (her ruling 23 Nov 2026, "Drop the list"): no word list decides whether copy reads as
// machine-written; the model reviewer judges that in context. The gate keeps every other rule, and a
// site's own claim guard (gate.banned_patterns: legal, defamation, health claims) is safety and stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateReport } from '../src/gate.mjs';
import { render } from '../src/render.mjs';
import { fixtureConfig, fixtureDraft, FIXTURE_CONFIG_RAW } from '../src/fixture.mjs';
import { checkConfig } from '../src/config.mjs';

const judge = (cfg, mut = () => {}) => {
  const d = fixtureDraft(); mut(d);
  const html = render(cfg, { slug: 'x', draft: d, related: [{ route: '/weekly-review/', anchor: 'How to run a weekly review' }], published: '2026-11-01' });
  return gateReport({ query: 'how to plan your week as a founder', html, facts: d.facts }, { cfg, corpus: [], siblings: [] });
};
// Every word of the old list, in the title, the answer and the body.
const OLD_WORDS = (d) => {
  d.title_lead = 'Unlock a seamless founder week';
  d.sections[0].paragraphs[0] += ' Elevate the plan, dive in, delve into the review and embark on a tailored, AI-powered week that will empower you and make it sparkle.';
  d.faq[0].a += ' In today\'s fast-paced world, plans slip.';
};

test('gate: the old machine-writing words neither block a page nor leave a note', () => {
  const r = judge(fixtureConfig(), OLD_WORDS);
  assert.deepEqual(r.problems, [], `blocked: ${r.problems.join('; ')}`);
  for (const n of r.notes) assert.doesNotMatch(n, /unlock|seamless|delve|tailored|sparkle|fast-paced|banned|filler phrase/i, `noted: ${n}`);
});

test('gate: the other rules still block that same page (prices, length bands, placeholders)', () => {
  const cfg = fixtureConfig();
  assert.ok(judge(cfg, (d) => { OLD_WORDS(d); d.sections[0].paragraphs[0] += ' Most planners charge $79 a month.'; }).problems.some((p) => /unsourced price/.test(p)), 'unsourced price');
  assert.ok(judge(cfg, (d) => { OLD_WORDS(d); d.direct_answer = 'Weekly planning is choosing three outcomes.'; }).problems.some((p) => /answer/i.test(p)), 'answer far under its length band');
  assert.ok(judge(cfg, (d) => { OLD_WORDS(d); d.sections[0].paragraphs[0] += ' [insert example here]'; }).problems.some((p) => /placeholder/.test(p)), 'leaked placeholder');
});

test('a config that still holds gate.banned_patterns runs: valid, and its claim guard still blocks (safety)', () => {
  // The hicks/horse configs carried the old ten words as site patterns until their own PRs drop them.
  const held = { ...FIXTURE_CONFIG_RAW, gate: { banned_patterns: ['\\badmissible\\b', '\\bseamless\\b'] } };
  assert.deepEqual(checkConfig(held), []);
  const cfg = { ...fixtureConfig(), gate: held.gate };
  assert.deepEqual(judge(cfg).problems, [], 'a clean page passes with the guard configured');
  assert.ok(judge(cfg, (d) => { d.sections[0].paragraphs[0] += ' A timestamped photo is admissible in court.'; }).problems.some((p) => /a claim this site never makes: "admissible"/.test(p)));
});
