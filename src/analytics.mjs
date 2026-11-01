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

// Last 24 hours from Cloudflare zone analytics (GraphQL). Returns
// { ai_visitors:{total, by_engine, by_path}, ai_bot_hits:{total, by_bot} } or { notRead }.
export async function cloudflareDay({ zoneName, token = process.env.CLOUDFLARE_API_TOKEN, fetchImpl = fetch, now = new Date() }) {
  if (!token) return { notRead: 'CLOUDFLARE_API_TOKEN is not set' };
  try {
    const z = await cf(`/zones?name=${encodeURIComponent(zoneName)}`, { token, fetchImpl });
    const zone = z.j?.result?.[0]?.id;
    if (!zone) return { notRead: `the Cloudflare token cannot see zone ${zoneName} (HTTP ${z.status}); it needs Zone:Read + Analytics:Read` };
    const since = new Date(now - 86400000).toISOString();
    const until = now.toISOString();
    const hosts = Object.keys(AI_REFERRERS.engines).filter((h) => !AI_REFERRERS.not_counted_as_ai.includes(AI_REFERRERS.engines[h]));
    const query = `query($zone:String!,$since:Time!,$until:Time!,$hosts:[String!],$bots:[ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!]){viewer{zones(filter:{zoneTag:$zone}){
      refs:httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_lt:$until,clientRefererHost_in:$hosts}){count dimensions{clientRefererHost clientRequestPath}}
      bots:httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_lt:$until,OR:$bots}){count dimensions{userAgent}}}}}`;
    const bots = AI_BOTS.bots.map((b) => ({ userAgent_like: `%${b.token}%` }));
    const g = await cf(null, { token, fetchImpl, body: { query, variables: { zone, since, until, hosts, bots } } });
    if (g.j?.errors?.length) return { notRead: `Cloudflare analytics refused the query: ${String(g.j.errors[0].message).slice(0, 120)}` };
    const zz = g.j?.data?.viewer?.zones?.[0];
    if (!zz) return { notRead: `Cloudflare analytics returned no zone data (HTTP ${g.status})` };
    const vis = { total: 0, by_engine: {}, by_path: {} };
    for (const r of zz.refs || []) {
      const e = aiEngineFor('https://' + r.dimensions.clientRefererHost);
      if (!e) continue;
      vis.total += r.count; vis.by_engine[e] = (vis.by_engine[e] || 0) + r.count;
      vis.by_path[r.dimensions.clientRequestPath] = (vis.by_path[r.dimensions.clientRequestPath] || 0) + r.count;
    }
    const hits = { total: 0, by_bot: {} };
    for (const r of zz.bots || []) {
      const b = botFor(r.dimensions.userAgent);
      if (!b) continue;
      hits.total += r.count; hits.by_bot[b] = (hits.by_bot[b] || 0) + r.count;
    }
    return { ai_visitors: vis, ai_bot_hits: hits, window: { since, until } };
  } catch (e) { return { notRead: `Cloudflare analytics failed: ${String(e.message).slice(0, 120)}` }; }
}
