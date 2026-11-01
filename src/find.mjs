// FIND (weekly, $0): measured and free signals only. Never paid or grounded
// model calls, never SERP scraping. A signal we could not read is written as
// "not read: <reason>", never invented.
import { searchAnalytics, dateDaysAgo } from './gsc.mjs';
import { norm, contentWords, tokenOverlap, fetchText, sleep, isoWeek } from './util.mjs';
import { ledger } from './ledger.mjs';
import { buildIndex } from './site-index.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';

export const QUESTION_PREFIXES = ['how to', 'what is', 'why', 'can', 'is', 'best way to'];
const NAV = /\b(login|log in|sign in|reddit|youtube|pdf download|coupon|promo code|torrent|apk|near me now|jobs|salary|careers)\b/;
const COMPETITION_NOT_READ = 'not read: no free, ToS-safe competition signal (SERP scraping is not used)';

export const keyOf = (q) => contentWords(q).sort().join(' ');

// Same search intent, different verb: "overcome / avoid / stop decision
// fatigue" is ONE page. Variants ride along as secondary queries.
export const INTENT_VERBS = new Set('overcome avoid stop beat fix reduce prevent handle manage deal get rid cope combat fight end break tips ways guide steps strategies ideas examples explained meaning definition simple easy good better really actually start improve'.split(' '));
const stem = (w) => w.replace(/(ing|ers|er|ed|es|s)$/, '');
export function intentKey(q) {
  const w = contentWords(q).filter((x) => !INTENT_VERBS.has(x)).map(stem);
  return (w.length ? w : contentWords(q).map(stem)).sort().join(' ');
}
// How much of the SEARCH an existing page's title/H1 already names (directional:
// a short generic title does not "cover" a longer, more specific search).
export function coverage(page, q, siteWords) {
  const words = (t) => new Set(contentWords(t).filter((w) => !siteWords.has(w)).map(stem));
  const intent = intentKey(q).split(' ').filter(Boolean);
  const share = (t) => { const T = words(t); return intent.length ? intent.filter((w) => T.has(w)).length / intent.length : 0; };
  return Math.max(share(page.title), share(page.h1));
}

export function scoreCandidate(s) {
  let score = 0;
  if (typeof s.gsc_position === 'number' && s.gsc_position >= 1) {
    const pos = Math.min(30, Math.max(8, s.gsc_position));
    score += ((30 - pos) / 22) * 40;
    score += Math.min(20, Math.log2((s.gsc_impressions || 0) + 1) * 4);
  }
  if (s.google_suggest) score += 15;
  if (s.bing_suggest) score += 10;
  if (s.google_suggest && s.bing_suggest) score += 5;
  if (s.bing_impressions) score += Math.min(15, Math.log2(s.bing_impressions + 1) * 3);
  if ((s.words || 0) >= 4) score += 10;
  if (s.question) score += 5;
  if (s.local) score += 5;
  return Math.round(score * 10) / 10;
}

export const isQuestion = (q) => /^(how|what|why|when|where|which|who|can|should|is|are|do|does|will)\b/.test(norm(q));

// Lexical floor: the suggestion carries every word of one topic seed, or two
// words of the site's vocabulary. The free-model screen below does the rest.
export function relevant(q, cfg) {
  const words = new Set(contentWords(q).map(stem));
  if (cfg.topics.some((t) => contentWords(t).map(stem).every((w) => words.has(w)))) return true;
  const vocab = new Set([...cfg.topics.flatMap(contentWords), ...contentWords(cfg.audience)].map(stem));
  return [...words].filter((w) => vocab.has(w)).length >= 2;
}

// One free-model pass over the best candidates: does this search belong to
// this site's audience? $0 route only; if it cannot answer, the lexical floor
// stands and the receipt says the screen was not read.
export async function relevanceScreen(cfg, list, { chat, fetchImpl }) {
  const keep = new Set();
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const r = await chat({ cfg, fetchImpl, maxTokens: 800, messages: [
      { role: 'system', content: 'You screen search queries for one website. Return ONLY JSON.' },
      { role: 'user', content: `Site: ${cfg.site_name} (${cfg.base_url}). Audience: ${cfg.audience}. Topics: ${cfg.topics.join(', ')}.\nKeep a query only if a person in this audience would type it AND a page from this site would be a genuinely useful answer (not a different meaning of the words, not a brand, product or navigation search for someone else).\nQueries:\n${batch.map((c, j) => `${j}. ${c.query}`).join('\n')}\nReturn {"keep":[numbers]}` },
    ] });
    if (!r.ok) return { notRead: r.reason };
    const j = parseJsonAnswer(r.answer);
    if (!Array.isArray(j?.keep)) return { notRead: 'the free model did not return {"keep":[...]}' };
    for (const n of j.keep) if (batch[n]) keep.add(batch[n]);
  }
  return { keep };
}

function suggester(name, urlFor, receipt, fetchImpl, budget) {
  let fails = 0;
  receipt.hosts[name] = { calls: 0, ok: 0, failed: 0, cost_usd: 0 };
  receipt.sources[name] = 'ok';
  return async (q) => {
    if (fails >= 3 || budget.left <= 0) return null;
    budget.left--;
    receipt.hosts[name].calls++;
    const r = await fetchText(urlFor(q), { fetchImpl, timeoutMs: 10000, headers: { 'user-agent': 'search-loop/1 (weekly query research; +https://github.com/seq23/search-loop)' } });
    await sleep(fetchImpl === fetch ? 350 : 0);
    let list = null;
    try { const j = JSON.parse(r.text); if (Array.isArray(j?.[1])) list = j[1].map(String); } catch { /* fall through */ }
    if (!r.ok || !list) {
      receipt.hosts[name].failed++;
      if (++fails >= 3) receipt.sources[name] = `not read: unavailable after 3 failures (last http ${r.status || r.error})`;
      return null;
    }
    fails = 0;
    receipt.hosts[name].ok++;
    return list;
  };
}

export async function readSharedClaims(cfg, fetchImpl = fetch) {
  const claims = [];
  const notes = [];
  for (const s of cfg.shares_audience_with || []) {
    try {
      let data;
      if (s.ledger_path) {
        const { readJson } = await import('./util.mjs');
        data = { targets: readJson(`${s.ledger_path}/targets.json`, {}), pages: readJson(`${s.ledger_path}/pages.json`, {}) };
      } else {
        const base = s.ledger_url.replace(/\/$/, '');
        const [t, p] = await Promise.all([fetchText(`${base}/targets.json`, { fetchImpl }), fetchText(`${base}/pages.json`, { fetchImpl })]);
        data = { targets: t.ok ? JSON.parse(t.text) : {}, pages: p.ok ? JSON.parse(p.text) : {} };
        if (!t.ok && !p.ok) notes.push(`not read: shared audience ${s.site || base} (http ${t.status})`);
      }
      for (const pg of data.pages?.pages || []) if (pg.status !== 'removed') claims.push({ site: s.site, query: pg.query, published: true });
      for (const t of data.targets?.targets || []) claims.push({ site: s.site, query: t.query, published: false });
    } catch (e) { notes.push(`not read: shared audience ${s.site || s.ledger_url} (${e.message})`); }
  }
  return { claims, notes };
}

// Two sites that share an audience never target the same search: a published
// claim always wins; between two unpublished targets the lower site id keeps it.
export function claimedElsewhere(q, cfg, claims) {
  const k = keyOf(q);
  return claims.find((c) => (keyOf(c.query) === k || tokenOverlap(c.query, q) >= 0.9) && (c.published || String(c.site) < String(cfg.site)));
}

export async function find(cfg, { fetchImpl = fetch, now = new Date(), index, chat = freeChat } = {}) {
  const L = ledger(cfg);
  const receipt = { schema: 'search-loop-discovery-v1', site: cfg.site, week: isoWeek(now), generated_at: now.toISOString(), paid_calls: 0, cost_usd: 0, hosts: {}, sources: {}, competition: COMPETITION_NOT_READ };
  const cands = new Map();
  const add = (q, sig) => {
    const n = norm(q);
    if (!n || n.length < 8 || NAV.test(n)) return;
    const words = n.split(' ').length;
    if (words < 2 || words > 14 || contentWords(n).length < 2) return;
    if ((cfg.find?.exclude_words || []).some((w) => n.includes(norm(w)))) return;
    const k = intentKey(n);
    const cur = cands.get(k) || { query: n, variants: [], signals: { words, question: isQuestion(n) } };
    if (cur.query !== n && !cur.variants.includes(n)) cur.variants.push(n);
    // the variant with the stronger measured signal names the page
    if (sig.gsc_position && !cur.signals.gsc_position) cur.query = n;
    Object.assign(cur.signals, sig);
    cands.set(k, cur);
  };

  // 1. Search Console rows at positions ~8-30 (measured).
  const gscSite = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'] || null;
  const measured = [];
  const sa = await searchAnalytics(gscSite, { startDate: dateDaysAgo(31, now), endDate: dateDaysAgo(3, now), dimensions: ['query', 'page'], rowLimit: 5000 }, { fetchImpl });
  if (sa.ok) {
    receipt.hosts['searchconsole.googleapis.com'] = { calls: 1, ok: 1, failed: 0, cost_usd: 0 };
    receipt.sources.search_console = `ok: ${sa.rows.length} rows`;
    for (const r of sa.rows) {
      const [query, page] = r.keys;
      measured.push({ query, impressions: r.impressions, position: r.position, page });
      if (r.position >= cfg.find.gsc_position_min && r.position <= cfg.find.gsc_position_max) {
        add(query, { gsc_position: Math.round(r.position * 10) / 10, gsc_impressions: r.impressions, gsc_page: page });
      }
    }
  } else receipt.sources.search_console = `not read: ${sa.reason}`;

  // 2. Bing Webmaster keyword data, only if a key exists.
  if (process.env.BING_WEBMASTER_API_KEY) {
    const r = await fetchText(`https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(cfg.base_url + '/')}&apikey=${process.env.BING_WEBMASTER_API_KEY}`, { fetchImpl });
    receipt.hosts['ssl.bing.com'] = { calls: 1, ok: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, cost_usd: 0 };
    try {
      const rows = JSON.parse(r.text).d || [];
      receipt.sources.bing_webmaster = `ok: ${rows.length} rows`;
      for (const x of rows) if (x.AvgImpressionPosition >= cfg.find.gsc_position_min && x.AvgImpressionPosition <= cfg.find.gsc_position_max) add(x.Query, { bing_impressions: x.Impressions, bing_position: x.AvgImpressionPosition });
    } catch { receipt.sources.bing_webmaster = `not read: http ${r.status || r.error}`; }
  } else receipt.sources.bing_webmaster = 'not read: BING_WEBMASTER_API_KEY is not set';

  // 3. Autocomplete (Google + Bing), seeded from measured queries + topic seeds + winners.
  const winners = L.read('winners', { topics: [] }).topics || [];
  const topMeasured = [...measured].sort((a, b) => b.impressions - a.impressions).map((m) => m.query).filter((q, i, a) => a.indexOf(q) === i).slice(0, 12);
  const places = cfg.local ? [cfg.local.city, ...(cfg.local.neighbourhoods || [])] : [];
  const seeds = [...new Set([...winners, ...topMeasured, ...cfg.topics, ...cfg.topics.flatMap((t) => places.map((p) => `${t} ${p}`))].map(norm))].filter(Boolean);
  const expansions = [];
  for (const s of seeds) { expansions.push(s); if (!isQuestion(s)) for (const p of QUESTION_PREFIXES) expansions.push(`${p} ${s}`); }
  const budget = { left: cfg.find.max_autocomplete_calls };
  const g = suggester('suggestqueries.google.com', (q) => `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`, receipt, fetchImpl, budget);
  const b = suggester('api.bing.com', (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`, receipt, fetchImpl, budget);
  for (const q of expansions) {
    if (budget.left <= 0) break;
    const isLocal = places.some((p) => q.includes(norm(p)));
    const [gl, bl] = [await g(q), await b(q)];
    for (const s of gl || []) if (relevant(s, cfg)) add(s, { google_suggest: true, ...(isLocal ? { local: true } : {}) });
    for (const s of bl || []) if (relevant(s, cfg)) add(s, { bing_suggest: true, ...(isLocal ? { local: true } : {}) });
  }
  if (budget.left <= 0) receipt.notes = [`autocomplete stopped at its budget of ${cfg.find.max_autocomplete_calls} calls`];

  // 4. Drop what the site already answers (those are strengthen candidates),
  //    and what a sibling with the same audience already holds.
  index = index || buildIndex(cfg);
  const siteWords = new Set(contentWords(cfg.site_name));
  const engine = L.pages().pages || [];
  const { claims, notes } = await readSharedClaims(cfg, fetchImpl);
  if (notes.length) receipt.shared_audience = notes;
  const targets = [];
  const strengthen = [];
  let droppedShared = 0;
  for (const c of cands.values()) {
    if (engine.some((p) => intentKey(p.query) === intentKey(c.query))) continue;
    const covering = index.find((p) => coverage(p, c.query, siteWords) >= 0.85);
    if (claimedElsewhere(c.query, cfg, claims)) { droppedShared++; continue; }
    c.score = scoreCandidate(c.signals);
    c.signals.competition = COMPETITION_NOT_READ;
    if (covering) strengthen.push({ ...c, page: covering.route });
    else targets.push({ ...c, kind: 'new' });
  }
  targets.sort((a, b) => b.score - a.score);
  const pool = targets.slice(0, 150);
  const screen = pool.length ? await relevanceScreen(cfg, pool, { chat, fetchImpl }) : { keep: new Set() };
  let screened = targets;
  if (screen.notRead) receipt.sources.relevance_screen = `not read: ${screen.notRead} (lexical floor only)`;
  else {
    screened = pool.filter((t) => screen.keep.has(t) || t.signals.gsc_position);
    receipt.sources.relevance_screen = `ok: kept ${screened.length} of ${pool.length} (free model)`;
  }
  strengthen.sort((a, b) => b.score - a.score);
  receipt.counts = { candidates: cands.size, targets: screened.length, strengthen_candidates: strengthen.length, dropped_shared_audience: droppedShared };
  const out = { schema: 'search-loop-targets-v1', site: cfg.site, week: receipt.week, generated_at: receipt.generated_at, sources: receipt.sources, targets: screened.slice(0, cfg.find.max_targets), strengthen: strengthen.slice(0, 50) };
  L.write('targets', out);
  L.write('receipt', receipt);
  return { targets: out.targets.length, strengthen: out.strengthen.length, sources: receipt.sources, receipt };
}
