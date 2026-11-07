import test from 'node:test';
import assert from 'node:assert/strict';
import { stopsInLog, KNOWN } from '../bin/report-stops.mjs';
import { intakePosts, reportToOpenLoops } from '../bin/open-loops.mjs';

test('a run that hung opens its row and clears every other known stop', () => {
  const log = 'search-loop find: 3 searches\nNAMED STOP [RUN_HUNG] stalled in build for 55 min\nNAMED NOTE [SECRET_MISSING_GSC_SITE_URL] not passed\n';
  const stops = stopsInLog(log);
  assert.deepEqual(stops, [{ code: 'RUN_HUNG', why: 'stalled in build for 55 min' }]);
  const posts = intakePosts({ repo: 'seq23/site', business: 'spry', finish: 'f', known: KNOWN, stops });
  assert.equal(posts.filter((p) => !p.cleared).length, 1);
  assert.equal(posts.filter((p) => p.cleared).length, KNOWN.length - 1);
  assert.ok(posts.every((p) => p.repo === 'seq23/site'));
});

test('a note or an unknown code never opens a row; a clean run clears them all', () => {
  assert.deepEqual(stopsInLog('NAMED NOTE [SECRET_MISSING_X] y\nNAMED STOP [SOMETHING_ELSE] z\n'), []);
  const posts = intakePosts({ repo: 'r', business: 'spry', finish: 'f', known: KNOWN, stops: [] });
  assert.equal(posts.length, KNOWN.length);
  assert.ok(posts.every((p) => p.cleared));
});

test('no token: nothing is sent and the run is not failed', async () => {
  const lines = [];
  let called = 0;
  const r = await reportToOpenLoops({ repo: 'r', business: 'spry', finish: 'f', known: KNOWN, stops: [] }, { token: '', fetchImpl: async () => { called++; }, log: (s) => lines.push(s) });
  assert.equal(called, 0);
  assert.equal(r.sent, 0);
  assert.match(lines[0], /not reported/);
});

test('with a token every post goes to the one intake with the bearer header', async () => {
  const seen = [];
  const r = await reportToOpenLoops({ repo: 'r', business: 'spry', finish: 'f', known: ['A', 'B'], stops: [{ code: 'A', why: 'w' }] },
    { token: 't', fetchImpl: async (url, init) => { seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return { ok: true }; }, log: () => {} });
  assert.equal(r.sent, 2);
  assert.ok(seen.every((s) => s.url === 'https://boss.sequoiataylor.com/api/boss/open-loops/intake' && s.auth === 'Bearer t'));
  assert.deepEqual(seen.map((s) => [s.body.stop, Boolean(s.body.cleared)]), [['A', false], ['B', true]]);
});
