// AI-referral visits and AI-bot hits, from free sources only.
// Privacy rule (from authority-backlink-network data/ai_referrers.json):
// referrers are matched on HOSTNAME only, never a full referring URL, which on
// some engines carries the person's question.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './util.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AI_REFERRERS = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'config', 'ai_referrers.json'), 'utf8'));
export const AI_BOTS = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'config', 'ai_bots.json'), 'utf8'));

// Hostname -> engine, or null. Ambiguous hosts (bing) are never counted as AI.
export function aiEngineFor(referrer) {
  let host;
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { host = String(referrer || '').toLowerCase().split('/')[0]; }
  const e = AI_REFERRERS.engines[host];
  return e && !AI_REFERRERS.not_counted_as_ai.includes(e) ? e : null;
}

export function botFor(ua) {
  const s = String(ua || '');
  return AI_BOTS.bots.find((b) => s.includes(b.token))?.name || null;
}

const CF = 'https://api.cloudflare.com/client/v4';

async function cf(pathOrQuery, { token, fetchImpl, body }) {
  const r = await fetchJson(body ? `${CF}/graphql` : `${CF}${pathOrQuery}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, fetchImpl, timeoutMs: 30000,
  });
  if (r.error) throw new Error(r.error);
  return { status: r.status, j: r.json };
}

// Last 24 hours from Cloudflare analytics (GraphQL), read separately so one unreadable half never
// hides the other (v1.5.1):
//   - AI-bot reads: zone httpRequestsAdaptiveGroups by userAgent (every plan, free included);
//   - AI-referral visits: the zone's clientRefererHost where the plan has it; on a free zone (no
//     referer field) Cloudflare Web Analytics (account rumPageloadEventsAdaptiveGroups, refererHost),
//     counted only when its beacon is really on the site: in the live home page's HTML, or at least
//     RUM_MIN_WEEK page loads in 7 days. A RUM page load can only exist if the beacon fired, so one
//     is already proof it is installed; the home-page probe is a second chance for a site so quiet
//     it has none (and it can fail on its own: Cloudflare may serve a runner a challenge instead of
//     the page). Only no evidence at all is "not read" with the reason, never a false 0. A beacon
//     that is on but quiet reports a true 0.
//     (Zone page views are no yardstick: on these sites they are mostly bots.)
// Returns { ai_visitors | visitorsNotRead, ai_bot_hits | botsNotRead, window } or { notRead } when nothing is readable.
export const RUM_MIN_WEEK = 1;
const NO_FIELD = /does not have access to the field/i;
export async function cloudflareDay({ zoneName, token = process.env.CLOUDFLARE_API_TOKEN, accountId = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch, now = new Date() }) {
  token = String(token || '').trim();
  if (!token) return { notRead: 'CLOUDFLARE_API_TOKEN is not set' };
  try {
    const z = await cf(`/zones?name=${encodeURIComponent(zoneName)}`, { token, fetchImpl });
    const zone = z.j?.result?.[0]?.id;
    if (!zone) return { notRead: `the Cloudflare token cannot see zone ${zoneName} (HTTP ${z.status}); it needs Zone:Read + Analytics:Read` };
    const since = new Date(now - 86400000).toISOString();
    const until = now.toISOString();
    const gql = async (query, variables) => {
      const g = await cf(null, { token, fetchImpl, body: { query, variables } });
      if (g.j?.errors?.length) return { error: String(g.j.errors[0].message).replace(/token\.[0-9a-f]+/g, 'token').slice(0, 160) };
      return { data: g.j?.data, status: g.status };
    };
    const out = { window: { since, until } };
    // AI-bot reads.
    const bots = AI_BOTS.bots.map((b) => ({ userAgent_like: `%${b.token}%` }));
    const b = await gql(`query($zone:String!,$since:Time!,$until:Time!,$bots:[ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!]){viewer{zones(filter:{zoneTag:$zone}){bots:httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_lt:$until,OR:$bots}){count dimensions{userAgent}}}}}`, { zone, since, until, bots });
    const bz = b.data?.viewer?.zones?.[0];
    if (b.error) out.botsNotRead = `Cloudflare analytics refused the bot query: ${b.error}`;
    else if (!bz) out.botsNotRead = `Cloudflare analytics returned no zone data (HTTP ${b.status})`;
    else {
      const hits = { total: 0, by_bot: {} };
      for (const r of bz.bots || []) { const n = botFor(r.dimensions.userAgent); if (!n) continue; hits.total += r.count; hits.by_bot[n] = (hits.by_bot[n] || 0) + r.count; }
      out.ai_bot_hits = hits;
    }
    // AI-referral visits.
    const hosts = Object.keys(AI_REFERRERS.engines).filter((h) => !AI_REFERRERS.not_counted_as_ai.includes(AI_REFERRERS.engines[h]));
    const tally = (rows, hostKey, pathKey) => {
      const vis = { total: 0, by_engine: {}, by_path: {} };
      for (const r of rows || []) {
        const e = aiEngineFor('https://' + r.dimensions[hostKey]);
        if (!e) continue;
        vis.total += r.count; vis.by_engine[e] = (vis.by_engine[e] || 0) + r.count;
        vis.by_path[r.dimensions[pathKey]] = (vis.by_path[r.dimensions[pathKey]] || 0) + r.count;
      }
      return vis;
    };
    const ref = await gql(`query($zone:String!,$since:Time!,$until:Time!,$hosts:[String!]){viewer{zones(filter:{zoneTag:$zone}){refs:httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_lt:$until,clientRefererHost_in:$hosts}){count dimensions{clientRefererHost clientRequestPath}}}}}`, { zone, since, until, hosts });
    if (!ref.error && ref.data?.viewer?.zones?.[0]) out.ai_visitors = tally(ref.data.viewer.zones[0].refs, 'clientRefererHost', 'clientRequestPath');
    else if (ref.error && !NO_FIELD.test(ref.error)) out.visitorsNotRead = `Cloudflare analytics refused the referral query: ${ref.error}`;
    else if (!accountId) out.visitorsNotRead = 'this zone\'s plan has no referrer field and CLOUDFLARE_ACCOUNT_ID is not set for Web Analytics';
    else {
      // Free zone: Web Analytics, if its beacon actually covers the site.
      const bare = zoneName.replace(/^www\./, '');
      const week = new Date(now - 7 * 86400000);
      const rum = await gql(`query($a:String!,$since:Time!,$until:Time!,$wk:Time!,$hosts:[String!]){viewer{accounts(filter:{accountTag:$a}){day:rumPageloadEventsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_lt:$until,requestHost_in:$hosts}){count dimensions{refererHost requestPath}} week:rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:$wk,datetime_lt:$until,requestHost_in:$hosts}){count}}}}`, { a: accountId, since, until, wk: week.toISOString(), hosts: [bare, `www.${bare}`] });
      const acct = rum.data?.viewer?.accounts?.[0];
      const beacon = (acct?.week || []).reduce((n, g) => n + g.count, 0);
      let onHome = false;
      try { const home = await fetchImpl(`https://${zoneName}/`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; search-loop analytics check)' } }); onHome = /cloudflareinsights\.com\/beacon/i.test(await home.text()); } catch { onHome = false; }
      if (rum.error) out.visitorsNotRead = `this zone's plan has no referrer field, and Web Analytics refused the query: ${rum.error}`;
      else if (!onHome && beacon < RUM_MIN_WEEK) out.visitorsNotRead = `this zone's plan has no referrer field, and the Cloudflare Web Analytics beacon is not on the site (not in the home page, no page loads in 7 days): turn on Web Analytics for ${bare}`;
      else out.ai_visitors = { ...tally(acct.day, 'refererHost', 'requestPath'), source: 'web-analytics' };
    }
    if (out.ai_visitors === undefined && out.ai_bot_hits === undefined) return { notRead: `${out.visitorsNotRead}; ${out.botsNotRead}` };
    return out;
  } catch (e) { return { notRead: `Cloudflare analytics failed: ${String(e.message).slice(0, 120)}` }; }
}
