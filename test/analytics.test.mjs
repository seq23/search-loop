import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareDay } from '../src/analytics.mjs';
import { sumDaily } from '../src/report.mjs';

const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A free Cloudflare zone: no referrer fields; userAgent works; Web Analytics answers at account level.
const freeZone = ({ beaconHtml, weekLoads, dayRefs = [] }) => async (u, init = {}) => {
  const s = String(u);
  if (s.includes('/zones?name=')) return J(200, { result: [{ id: 'z1' }] });
  if (s.endsWith('/graphql')) {
    const q = JSON.parse(init.body).query;
    if (q.includes('bots:httpRequestsAdaptiveGroups')) return J(200, { data: { viewer: { zones: [{ bots: [{ count: 7, dimensions: { userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.1)' } }, { count: 3, dimensions: { userAgent: 'Mozilla/5.0 Chrome' } }] }] } } });
    if (q.includes('clientRefererHost')) return J(200, { errors: [{ message: "zone 'z1' does not have access to the field 'clientrefererhost' from type 'ZoneHttpRequestsAdaptiveGroupsDimensions'" }] });
    if (q.includes('rumPageloadEventsAdaptiveGroups')) return J(200, { data: { viewer: { accounts: [{ day: dayRefs, week: [{ count: weekLoads }] }] } } });
  }
  if (s.startsWith('https://example.org/')) return new Response(beaconHtml ? '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>' : '<html></html>', { status: 200 });
  return J(404, {});
};

test('free zone: bot reads are counted even though the referrer field is refused', async () => {
  const r = await cloudflareDay({ zoneName: 'example.org', token: 't\n', accountId: 'a', fetchImpl: freeZone({ beaconHtml: false, weekLoads: 1 }) });
  assert.equal(r.notRead, undefined);
  assert.equal(r.ai_bot_hits.total, 7, 'only AI bots count');
  assert.equal(r.ai_visitors, undefined);
  assert.match(r.visitorsNotRead, /beacon is not on the site/, 'no beacon is "not read", never 0');
});

test('free zone with the Web Analytics beacon: AI-referral visits come from Web Analytics', async () => {
  const r = await cloudflareDay({ zoneName: 'example.org', token: 't', accountId: 'a', fetchImpl: freeZone({ beaconHtml: true, weekLoads: 2, dayRefs: [{ count: 4, dimensions: { refererHost: 'chatgpt.com', requestPath: '/a/' } }, { count: 9, dimensions: { refererHost: 'www.google.com', requestPath: '/b/' } }] }) });
  assert.equal(r.ai_visitors.total, 4);
  assert.equal(r.ai_visitors.source, 'web-analytics');
  assert.equal(r.ai_bot_hits.total, 7);
});

test('the week report carries the bot number while visits say why they were not read', () => {
  const daily = { days: { '2026-11-03': { ai_bot_hits: { total: 7 }, ai_visitors_not_read: 'beacon is not on the site' } } };
  assert.equal(sumDaily(daily, 'ai_bot_hits', '2026-11-03'), 7);
  assert.match(sumDaily(daily, 'ai_visitors', '2026-11-03'), /^not read: beacon is not on the site/);
});
