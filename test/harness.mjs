// Shared test harness (engine.test.mjs, ai-misses.test.mjs): a tmp site, one fake internet, fake free models.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FIXTURE_CONFIG_RAW, fixtureDraft } from '../src/fixture.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
process.env.GSC_SITE_URL = 'sc-domain:example.com';
process.env.OPENROUTER_API_KEY = 'test-key';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.BING_WEBMASTER_API_KEY;

export const filler = (n) => `<p>${'Planning is a habit you build one week at a time with a short review. '.repeat(n)}</p>`;
export function site({ cfg = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w('index.html', '<html><head><title>Example Planner — plan your week</title></head><body><nav><a href="/download">Get it</a><a href="/weekly-planning/">Weekly planning</a></nav><main><h1>Example Planner</h1></main></body></html>');
  w('weekly-planning/index.html', `<html><head><title>Weekly planning for founders — Example Planner</title></head><body><main><article><h1>Weekly planning for founders</h1>${filler(20)}</article></main></body></html>`);
  w('weekly-review/index.html', `<html><head><title>How to run a weekly review — Example Planner</title></head><body><main><article><h1>How to run a weekly review for your planning</h1>${filler(20)}</article></main></body></html>`);
  w('download.html', '<html><head><title>Download — Example Planner</title></head><body><main><h1>Download weekly planning kit</h1><a href="https://buy.example.com">Buy</a></main></body></html>');
  w('search-loop.config.json', JSON.stringify({ ...FIXTURE_CONFIG_RAW, ...cfg }));
  return root;
}

// One fake internet: Google token + Search Console + autocomplete + sources + live pages + IndexNow.
// cmpRows: what the comparison pull (a query includingRegex filter, v1.16.0) returns; cmpStatus: its HTTP status.
export function fakeFetch({ gscRows = [], pageRows = [], dateRows = [], cmpRows = [], cmpStatus = 200, inspectIndexed = true, live = true, calls = [], bodies = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/searchAnalytics/query')) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.dimensionFilterGroups?.[0]?.filters?.[0]?.operator === 'includingRegex') return cmpStatus === 200 ? json(200, { rows: cmpRows }) : json(cmpStatus, { error: { message: 'backend error' } });
      return json(200, { rows: body.dimensions[0] === 'date' ? dateRows : body.dimensions[0] === 'page' ? pageRows : body.dimensions.length === 1 ? [{ keys: ['plan week founder'], clicks: 0, impressions: 5, position: 14 }] : gscRows });
    }
    if (u.includes('urlInspection')) return json(200, { inspectionResult: { indexStatusResult: { verdict: inspectIndexed ? 'PASS' : 'NEUTRAL', coverageState: 'x' } } });
    if (u.includes('suggestqueries.google.com')) { const q = new URL(u).searchParams.get('q'); return json(200, [q, [`${q} for founders`, `${q} template`]]); }
    if (u.includes('api.bing.com/osjson')) { const q = new URL(u).searchParams.get('query'); return json(200, [q, [`${q} for founders`]]); }
    if (u.includes('raw.githubusercontent.com')) return json(404, {});
    if (u.includes('wikipedia.org')) return new Response('<html>' + 'x'.repeat(1000) + '</html>', { status: 200 });
    if (u.includes('indexnow')) return new Response('', { status: 202 });
    if (u.startsWith('https://example.com/')) return new Response('ok', { status: live ? 200 : 404 });
    return new Response('nope', { status: 404 });
  };
}

export const goodChat = (calls = []) => async ({ messages }) => {
  calls.push(messages);
  const q = (messages[1].content.match(/Search to answer: "([^"]+)"/) || [])[1] || 'weekly planning';
  const d = fixtureDraft();
  const cap = q.charAt(0).toUpperCase() + q.slice(1);
  d.h1 = cap.length > 28 ? cap : `${cap}: a simple guide`;
  d.title_lead = cap.slice(0, 44);
  // a different answer per search (the distinct gate compares answers too)
  const vocab = 'calendar outcome review morning block focus habit notebook energy meeting inbox priority deadline client launch budget hiring sprint retro goal metric team weekend travel sleep coffee walk call email draft invoice roadmap pitch investor demo feedback lesson routine checklist template sunday friday quarter month season'.split(' ');
  const h = crypto.createHash('sha256').update(q).digest();
  const words = vocab.map((w, i) => [h[i % 32] * 64 + i, w]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).slice(0, 40);
  d.direct_answer = `${cap} is ${words.join(' ')}.`;
  // make each page distinct enough to pass the near-duplicate check
  d.sections = d.sections.map((s, i) => ({ ...s, heading: `${s.heading} (${q})`, paragraphs: s.paragraphs.map((p) => `${p} This part is about ${q} and step ${i} of ${q.split(' ').reverse().join(' ')}.`.replace(/Weekly planning works/, `${cap} works`)) }));
  delete d.facts[0].verified; delete d.facts[1].verified;
  return { ok: true, answer: '```json\n' + JSON.stringify(d) + '\n```' };
};

// Pages whose body text is really different per search (goodChat's bodies share
// most sentences, so the near-duplicate gate lets only a few through).
export const distinctChat = (calls = []) => async (args) => {
  const d = JSON.parse((await goodChat(calls)(args)).answer.replace(/^```json\n|\n```$/g, ''));
  const q = d.h1;
  const vocab = 'calendar outcome review morning block focus habit notebook energy meeting inbox priority deadline client launch budget hiring sprint retro goal metric team weekend travel sleep coffee walk call email draft invoice roadmap pitch investor demo feedback lesson routine checklist template sunday friday quarter month season'.split(' ');
  const text = (seed) => { const h = crypto.createHash('sha256').update(q + seed).digest(); return Array.from({ length: 130 }, (_, i) => vocab[(h[i % 32] + i * h[(i + 7) % 32]) % vocab.length]).join(' ') + '.'; };
  d.sections = d.sections.map((x, i) => ({ ...x, paragraphs: [text(`a${i}`), text(`b${i}`)] }));
  return { ok: true, answer: JSON.stringify(d) };
};

export const NOW = new Date('2026-11-02T15:00:00Z');
