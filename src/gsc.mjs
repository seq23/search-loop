// Google Search Console with a service account, no dependencies.
// Free: Search Analytics (rows) and URL Inspection (2,000/day/property).
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
let cached = null;

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function gscToken({ json = process.env.GSC_SERVICE_ACCOUNT_JSON, fetchImpl = fetch } = {}) {
  if (!json) return { ok: false, reason: 'GSC_SERVICE_ACCOUNT_JSON is not set' };
  if (cached && cached.exp > Date.now() + 60000) return { ok: true, token: cached.token };
  let sa;
  try { sa = JSON.parse(json); } catch { return { ok: false, reason: 'GSC_SERVICE_ACCOUNT_JSON is not JSON' }; }
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  let sig;
  try { sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key); } catch (e) { return { ok: false, reason: `service account key unusable: ${e.message}` }; }
  const assertion = `${head}.${claim}.${b64u(sig)}`;
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) return { ok: false, reason: `token exchange HTTP ${res.status}` };
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return { ok: true, token: j.access_token };
  } catch (e) { return { ok: false, reason: `token exchange failed: ${e.message}` }; }
}

async function call(url, body, fetchImpl) {
  const t = await gscToken({ fetchImpl });
  if (!t.ok) return { ok: false, reason: t.reason };
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${String(j?.error?.message || '').slice(0, 100)}` };
    return { ok: true, data: j };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function searchAnalytics(siteUrl, body, { fetchImpl = fetch } = {}) {
  if (!siteUrl) return { ok: false, reason: 'no Search Console property configured (gsc.site_url / its env var)' };
  const r = await call(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body, fetchImpl);
  if (!r.ok) return r;
  return { ok: true, rows: r.data.rows || [] };
}

export async function inspectUrl(siteUrl, url, { fetchImpl = fetch } = {}) {
  const r = await call('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl }, fetchImpl);
  if (!r.ok) return r;
  const st = r.data?.inspectionResult?.indexStatusResult || {};
  return { ok: true, verdict: st.verdict || null, coverage: st.coverageState || null, indexed: st.verdict === 'PASS' };
}

export const dateDaysAgo = (n, now = new Date()) => new Date(now - n * 86400000).toISOString().slice(0, 10);
