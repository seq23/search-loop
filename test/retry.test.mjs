import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixableDrop, retryWaitDays, offLanguage, FIXABLE_RETRY_DAYS, DROP_RETRY_DAYS } from '../src/build.mjs';

const faq = { query: 'ai leadership coach', at: '2026-11-08', reason: ['b5 FAQ answer is 23 words (aim 40-60): "Is it"'] };
const sources = { query: 'ai management coach', at: '2026-11-08', reason: ['facts: needs at least 2 distinct sources whose URLs answered 200 (found 1)'] };

test('a drop with only fixable problems is retried after 3 days, then 28 after 3 drops', () => {
  assert.ok(fixableDrop(faq) && fixableDrop(sources));
  assert.equal(retryWaitDays(faq, 1), FIXABLE_RETRY_DAYS);
  assert.equal(retryWaitDays(sources, 2), FIXABLE_RETRY_DAYS);
  assert.equal(retryWaitDays(faq, 3), DROP_RETRY_DAYS);
});

test('off-audience, invented or mixed problems still wait 28 days', () => {
  const off = { query: 'hrider', reason: ['off-audience: HRider is an HR platform'] };
  const mixed = { query: 'x', reason: [faq.reason[0], 'invented: unsourced statistic "70%"'] };
  const path = { query: 'y', reason: 'path exists or is protected' };
  for (const d of [off, mixed, path]) { assert.equal(fixableDrop(d), false); assert.equal(retryWaitDays(d, 1), DROP_RETRY_DAYS); }
});

test('searches clearly in another language are skipped on an English site; English ones are kept', () => {
  for (const q of ['gibt es was besseres', 'executive coaching kosten per sessie', 'hoe vaak vinden coachingsessies plaats', 'coaching für führungskräfte']) assert.ok(offLanguage({}, q), q);
  for (const q of ['ai leadership coach', 'how to stop overthinking', 'betterup vs coachhub', 'what is executive dysfunction']) assert.equal(offLanguage({}, q), false, q);
  assert.equal(offLanguage({ language: 'de' }, 'gibt es was besseres'), false);
});
