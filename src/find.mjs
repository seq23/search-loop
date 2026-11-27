// FIND (weekly, $0): measured and free signals only. Never paid or grounded
// model calls, never SERP scraping. Since v1.6.0 every target is in one of two
// lanes (compete.mjs): can_be_one (competition score) or striking (scoreCandidate). A signal we could not read is written as
// "not read: <reason>", never invented.
import { searchAnalytics, dateDaysAgo, comparisonFilter } from './gsc.mjs';
import { norm, contentWords, tokenOverlap, fetchText, sleep, isoWeek, pastSoft, progress, centralDate } from './util.mjs';
import { ledger } from './ledger.mjs';
import { buildIndex } from './site-index.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { seedList, seedBook, saveSeedBook, setSeed, DONE as SEED_DONE } from './seeds.mjs';
import { easyWins, placeVariants, gscCompetition, canBeOneScore, readTop10, weightsOf, laneRatio, assignLanes, COMPETE_DEFAULTS } from './compete.mjs';

export const QUESTION_PREFIXES = ['how to', 'what is', 'why', 'can', 'is', 'best way to'];
const NAV = /\b(login|log in|sign in|reddit|youtube|pdf download|coupon|promo code|torrent|apk|near me now|jobs|salary|careers)\b/;

export const keyOf = (q) => contentWords(q).sort().join(' ');

// Same search intent, different verb: "overcome / avoid / stop decision
// fatigue" is ONE page. Variants ride along as secondary queries.
export const INTENT_VERBS = new Set('overcome avoid stop beat fix reduce prevent handle manage deal get rid cope combat fight end break tips ways guide steps strategies ideas examples explained meaning definition simple easy good better really actually start improve'.split(' '));
export const stem = (w) => w.replace(/(ing|ers|er|ed|es|s)$/, '');
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

// The site's priority searches (v1.11.0): the first `find.priority_topics` entries of `topics`.
// They are asked about first, screened first and built first (build.mjs), so a site that puts
// its buyers' searches at the top of `topics` and says how many gets pages for those first.
export const priorityTopics = (cfg) => cfg.topics.slice(0, Math.max(0, Math.min(cfg.topics.length, Number(cfg.find?.priority_topics) || 0))).map(norm).filter(Boolean);
// The priority topic a search belongs to: it carries more than half of that topic's words
// (both words of a two-word topic). Where the search came from does not matter, so an
// autocomplete answer that drifted off the topic ("debt service cost") is not priority.
export function priorityTopic(q, cfg) {
  const words = new Set(contentWords(q).map(stem));
  return priorityTopics(cfg).find((t) => { const w = [...new Set(contentWords(t).map(stem))]; return w.length > 0 && w.filter((x) => words.has(x)).length > w.length / 2; }) || null;
}

// What the weekly autocomplete budget is spent on, in order (v1.11.0). Every seed is asked
// bare before any seed gets a question prefix, and the site's own topics come before the
// queries Search Console already shows. Before this the measured queries went first with all
// six prefixes each, so six of them used the whole default budget (80 calls = 40 questions)
// and no config topic was ever asked (approvalprep.com and weddingchecklistpdf.com, W46 2026:
// 0 of 30 and 0 of 16 topics asked; a re-ordered `topics` list changed nothing).
export function expansionPlan(cfg, { wins = [], winners = [], measured = [], places = [] } = {}) {
  const pri = priorityTopics(cfg);
  const topics = cfg.topics.map(norm).filter(Boolean);
  const seeds = [];
  const seen = new Set();
  const push = (list, kind) => { for (const q of list.map(norm)) if (q && !seen.has(q)) { seen.add(q); seeds.push({ seed: q, kind, priority: pri.includes(q) ? q : null }); } };
  push(pri, 'topic'); push(wins, 'easy_win'); push(topics, 'topic'); push(winners, 'winner'); push(measured, 'measured');
  push(cfg.topics.flatMap((t) => places.map((p) => `${t} ${p}`)), 'local');
  const plan = seeds.map((s) => ({ q: s.seed, ...s, bare: true }));
  for (const p of QUESTION_PREFIXES) for (const s of seeds) if (!isQuestion(s.seed)) plan.push({ q: `${p} ${s.seed}`, ...s, bare: false });
  return plan;
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
// v1.16.0: the same pass also says which kept queries are comparisons (the person is choosing
// between options), so a Search Console comparison row gets priority only when a model read it so.
export async function relevanceScreen(cfg, list, { chat, fetchImpl }) {
  const keep = new Set();
  const comparison = new Set();
  let comparisonRead = true;
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    progress('find', `free-model screen ${i + 1}-${i + batch.length} of ${list.length}`);
    const r = await chat({ cfg, fetchImpl, maxTokens: 800, messages: [
      { role: 'system', content: 'You screen search queries for one website. Return ONLY JSON.' },
      { role: 'user', content: `Site: ${cfg.site_name} (${cfg.base_url}). Audience: ${cfg.audience}. Topics: ${cfg.topics.join(', ')}.\nKeep a query only if a person in this audience would type it AND a page from this site would be a genuinely useful answer (not a different meaning of the words, not a brand, product or navigation search for someone else; a person comparing other products or looking for an alternative to one is this site's audience when the site offers such an option, so keep that search).\nSeparately, for EVERY query (kept or not), say whether it is a comparison: the person is choosing between options ("x vs y", "x or y", "alternatives to x", "x instead of y", "better than x", "switching from x"). A query that only contains such a word with another meaning (a therapy or a part called "replacement") is not a comparison.\nQueries:\n${batch.map((c, j) => `${j}. ${c.query}`).join('\n')}\nReturn {"keep":[numbers],"comparison":[numbers]}` },
    ] });
    if (!r.ok) return { notRead: r.reason };
    const j = parseJsonAnswer(r.answer);
    if (!Array.isArray(j?.keep)) return { notRead: 'the free model did not return {"keep":[...]}' };
    for (const n of j.keep) if (batch[n]) keep.add(batch[n]);
    if (!Array.isArray(j.comparison)) comparisonRead = false;
    else for (const n of j.comparison) if (batch[n]) comparison.add(batch[n]);
  }
  return { keep, comparison, ...(comparisonRead ? {} : { comparisonNotRead: 'the free model did not return "comparison":[...]' }) };
}

function suggester(name, urlFor, receipt, fetchImpl, budget) {
  let fails = 0;
  receipt.hosts[name] = { calls: 0, ok: 0, failed: 0, cost_usd: 0 };
  receipt.sources[name] = 'ok';
  return async (q) => {
    if (fails >= 3 || budget.left <= 0 || pastSoft()) return null;
    budget.left--;
    receipt.hosts[name].calls++;
    const r = await fetchText(urlFor(q), { fetchImpl, timeoutMs: 10000, retries: 0, headers: { 'user-agent': 'search-loop/1 (weekly query research; +https://github.com/seq23/search-loop)' } });
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

export async function find(cfg, { fetchImpl = fetch, now = new Date(), index, chat = freeChat, aiMisses = [] } = {}) {
  const L = ledger(cfg);
  const receipt = { schema: 'search-loop-discovery-v1', site: cfg.site, week: isoWeek(now), generated_at: now.toISOString(), paid_calls: 0, cost_usd: 0, hosts: {}, sources: {} };
  const cands = new Map();
  const add = (q, sig) => {
    const n = norm(q);
    if (!n || n.length < 8 || NAV.test(n)) return null;
    const words = n.split(' ').length;
    if (words < 2 || words > 14 || contentWords(n).length < 2) return null;
    if ((cfg.find?.exclude_words || []).some((w) => n.includes(norm(w)))) return null;
    const k = intentKey(n);
    const cur = cands.get(k) || { query: n, variants: [], signals: { words, question: isQuestion(n) } };
    if (cur.query !== n && !cur.variants.includes(n)) cur.variants.push(n);
    // the variant with the stronger measured signal names the page
    if (sig.gsc_position && !cur.signals.gsc_position) cur.query = n;
    // v1.16.0: a search only the comparison pull found needs the free-model screen to keep it.
    if (sig.comparison_pull) { if (!cands.has(k)) cur.signals.comparison_only = true; } else delete cur.signals.comparison_only;
    Object.assign(cur.signals, sig);
    cur.priority ||= priorityTopic(n, cfg) || undefined;
    cands.set(k, cur);
    return cur;
  };

  // 0. AI answer misses with no page that fits (v1.14.0, Boss OS): the buyer questions
  //    ChatGPT, Gemini or AI Overviews answered without this site. They pass every gate
  //    below like any other search, and lead the list when they survive.
  const aiOutcome = new Map();
  for (const m of aiMisses) {
    const c = add(m.prompt, {});
    if (!c) { aiOutcome.set(m.id, { action: 'skipped', reason: 'not a page-sized search (too short or long, a navigation search, or a find.exclude_words word)' }); continue; }
    (c.ai_miss_ids ||= []).includes(m.id) || c.ai_miss_ids.push(m.id);
    c.signals.ai_miss = true;
  }

  // 0b. Hand-given searches (config `seeds`, v1.17.0): the searches ChatGPT runs before it
  //     recommends an app in this site's category. Each goes through every check below like a
  //     found search; one already built, strengthened or answered is not asked again.
  const seedsOut = new Map();
  const sbook = seedBook(L);
  for (const s of seedList(cfg)) {
    if (SEED_DONE.has(sbook.seeds[s.key]?.status)) continue;
    const c = add(s.query, {});
    if (!c) { seedsOut.set(s.key, { query: s.query, status: 'refused', reason: 'not a page-sized search (too short or long, a navigation search, or a find.exclude_words word)' }); continue; }
    c.signals.seed = true;
    c.seed = { query: s.query, wants: s.wants, key: s.key };
  }

  // 1. Search Console rows at positions ~8-30 (measured).
  const gscSite = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'] || null;
  const measured = [];
  progress('find', 'Search Console queries');
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

  // 1b. Comparison searches (v1.16.0, her tip 27 Nov 2026): one more Search Console pull that
  //     Search Console itself filters to "x vs y / alternatives to / instead of / better than /
  //     switch from" searches (gsc.mjs COMPARISON_REGEX). Any position from gsc_position_min down:
  //     a person choosing between options is the buyer. The free-model screen below confirms each
  //     row is a comparison before it is built first. A row the normal pull also has is one
  //     candidate (same intent key). This pull failing leaves every other pick as it was.
  progress('find', 'Search Console comparison searches');
  const cmp = await searchAnalytics(gscSite, { startDate: dateDaysAgo(31, now), endDate: dateDaysAgo(3, now), dimensions: ['query', 'page'], dimensionFilterGroups: comparisonFilter(), rowLimit: 1000 }, { fetchImpl });
  const gscHost = (receipt.hosts['searchconsole.googleapis.com'] ||= { calls: 0, ok: 0, failed: 0, cost_usd: 0 });
  gscHost.calls++;
  if (cmp.ok) {
    gscHost.ok++;
    let tooHigh = 0;
    for (const r of cmp.rows) {
      const [query, page] = r.keys;
      if (r.position < cfg.find.gsc_position_min) { tooHigh++; continue; }
      add(query, { comparison_pull: true, comparison_position: Math.round(r.position * 10) / 10, comparison_impressions: r.impressions, comparison_page: page });
    }
    receipt.sources.comparison_pull = `ok: ${cmp.rows.length} row(s)${tooHigh ? ` (${tooHigh} already above position ${cfg.find.gsc_position_min}, left alone)` : ''}`;
  } else {
    gscHost.failed++;
    receipt.sources.comparison_pull = `not read: comparison pull: couldn't read Search Console (${cmp.reason}); the normal pick is unchanged`;
  }

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

  // 2b. Easy wins (top 3 with few impressions, or an engine page top 3 at 2 weeks):
  //     their close variants are the first can-be-#1 candidates.
  const wins = easyWins(measured, L.pages().pages || []);
  receipt.sources.easy_wins = sa.ok ? `ok: ${wins.length} easy win(s) in Search Console` : `not read: ${sa.reason}`;
  const places0 = cfg.local ? [cfg.local.city, ...(cfg.local.neighbourhoods || [])] : [];
  for (const v of placeVariants(wins, places0)) if (relevant(v.query, cfg)) add(v.query, { local: true, place_variant_of: v.of });

  // 3. Autocomplete (Google + Bing), seeded from easy wins + measured queries + topic seeds + winners.
  const winners = L.read('winners', { topics: [] }).topics || [];
  const topMeasured = [...measured].sort((a, b) => b.impressions - a.impressions).map((m) => m.query).filter((q, i, a) => a.indexOf(q) === i).slice(0, 12);
  const places = cfg.local ? [cfg.local.city, ...(cfg.local.neighbourhoods || [])] : [];
  const plan = expansionPlan(cfg, { wins: wins.map((w) => w.query), winners, measured: topMeasured, places });
  const budget = { left: cfg.find.max_autocomplete_calls };
  progress('find', 'autocomplete expansions');
  const g = suggester('suggestqueries.google.com', (q) => `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`, receipt, fetchImpl, budget);
  const b = suggester('api.bing.com', (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`, receipt, fetchImpl, budget);
  const askedSeeds = new Set();
  let asked = 0;
  for (const e of plan) {
    if (budget.left <= 0) break;
    const isLocal = places.some((p) => e.q.includes(norm(p)));
    const [gl, bl] = [await g(e.q), await b(e.q)];
    if (gl || bl) { asked++; askedSeeds.add(e.seed); }
    for (const s of gl || []) if (relevant(s, cfg)) add(s, { google_suggest: true, ...(isLocal ? { local: true } : {}) });
    for (const s of bl || []) if (relevant(s, cfg)) add(s, { bing_suggest: true, ...(isLocal ? { local: true } : {}) });
  }
  const topicSeeds = [...new Set(cfg.topics.map(norm).filter(Boolean))];
  const unasked = topicSeeds.filter((t) => !askedSeeds.has(t));
  receipt.seeds = { planned: plan.length, asked, topics: topicSeeds.length, topics_asked: topicSeeds.length - unasked.length, priority_topics: priorityTopics(cfg).length };
  receipt.notes = [];
  // Rule 0: a topic the budget never reached is named, never silently skipped.
  if (budget.left <= 0 && unasked.length) receipt.notes.push(`NAMED NOTE [FIND_TOPICS_UNASKED] autocomplete stopped at its budget of ${cfg.find.max_autocomplete_calls} calls before ${unasked.length} of ${topicSeeds.length} topic seed(s) were asked (first: "${unasked[0]}"); raise find.max_autocomplete_calls or trim topics`);
  if (budget.left <= 0) receipt.notes.push(`autocomplete stopped at its budget of ${cfg.find.max_autocomplete_calls} calls (${asked} of ${plan.length} planned questions asked)`);

  // 4. Drop what the site already answers (those are strengthen candidates),
  //    and what a sibling with the same audience already holds.
  index = index || buildIndex(cfg);
  const siteWords = new Set(contentWords(cfg.site_words || cfg.site_name));
  const engine = L.pages().pages || [];
  const { claims, notes } = await readSharedClaims(cfg, fetchImpl);
  if (notes.length) receipt.shared_audience = notes;
  const weights = weightsOf(L);
  const targets = [];
  const strengthen = [];
  let droppedShared = 0;
  const aiSkip = (c, reason) => { for (const id of c.ai_miss_ids || []) aiOutcome.set(id, { action: 'skipped', reason }); };
  // A seed whose intent a live engine page already has strengthens that page (CHECK); one a
  // hand-built page answers is recorded there (the engine never edits a hand-built page).
  const seedTo = (c, rec) => { if (c.seed) seedsOut.set(c.seed.key, { query: c.seed.query, ...rec }); };
  const liveEngine = (route) => engine.find((p) => p.route === route && p.status === 'live');
  for (const c of cands.values()) {
    const dup = engine.find((p) => intentKey(p.query) === intentKey(c.query));
    if (dup) {
      aiSkip(c, `an engine page already has this intent: ${dup.route}`);
      if (dup.status === 'live') seedTo(c, { status: 'strengthen', url: dup.url, route: dup.route, reason: `same intent as the engine page ${dup.url}: strengthened there, not a second page` });
      else seedTo(c, { status: 'refused', reason: `an engine page with this intent was ${dup.status} (${dup.route})` });
      continue;
    }
    const covering = index.find((p) => coverage(p, c.query, siteWords) >= 0.85);
    if (claimedElsewhere(c.query, cfg, claims)) { aiSkip(c, 'a sibling site with the same audience already holds this search'); seedTo(c, { status: 'refused', reason: 'a sibling site with the same audience already holds this search' }); droppedShared++; continue; }
    if (covering) aiSkip(c, `the site already answers it at ${covering.route} (a strengthen candidate)`);
    if (covering) {
      const eng = liveEngine(covering.route);
      seedTo(c, eng ? { status: 'strengthen', url: eng.url, route: eng.route, reason: `the engine page ${eng.url} already covers it: strengthened there, not a second page` } : { status: 'answered_by', url: cfg.base_url + covering.route, route: covering.route, reason: 'a hand-built page on the site already answers it; the engine never edits hand-built pages' });
    }
    c.scores = { striking: scoreCandidate(c.signals) };
    const covered = Math.max(0, ...index.map((p) => coverage(p, c.query, siteWords)));
    Object.assign(c.signals, gscCompetition(c, { wins, measured, covered }));
    c.scores.can_be_one = canBeOneScore(c.signals, weights).score;
    c.score = c.scores.striking;
    if (covering) strengthen.push({ ...c, page: covering.route });
    else targets.push({ ...c, kind: 'new' });
  }
  // the screen sees the best of both lanes
  const byOne = [...targets].sort((a, b) => b.scores.can_be_one - a.scores.can_be_one);
  targets.sort((a, b) => b.score - a.score);
  const pool = [...new Set([...targets.filter((t) => t.ai_miss_ids).slice(0, 50), ...targets.filter((t) => t.signals.comparison_pull).slice(0, 50), ...targets.filter((t) => t.seed), ...targets.filter((t) => t.priority).slice(0, 75), ...byOne.slice(0, 75).filter((t) => t.scores.can_be_one > 0), ...targets])].slice(0, 150);
  const screen = pool.length ? await relevanceScreen(cfg, pool, { chat, fetchImpl }) : { keep: new Set() };
  let screened = targets;
  const cmpRows = targets.filter((t) => t.signals.comparison_pull);
  if (screen.notRead) {
    receipt.sources.relevance_screen = `not read: ${screen.notRead} (lexical floor only)`;
    // A search only the comparison pull found was never measured in the normal window and never
    // asked of autocomplete: with no model to read it, it is not built this run.
    // A seed was never measured or asked of autocomplete either: no model, no seed page this run.
    screened = targets.filter((t) => !t.signals.comparison_only && !t.seed);
    for (const t of targets) if (t.seed) seedTo(t, { status: 'queued', reason: `not built this run: the free-model relevance screen was not read (${screen.notRead})` });
  } else {
    // Measured rows stand without the keep vote, as before; a comparison-pull row is measured too
    // (Search Console shows the site for it), so the model's comparison read is its vote (v1.16.0).
    screened = pool.filter((t) => screen.keep.has(t) || t.signals.gsc_position || (t.signals.comparison_pull && screen.comparison?.has(t)));
    receipt.sources.relevance_screen = `ok: kept ${screened.length} of ${pool.length} (free model)`;
    for (const t of targets) if (t.seed && !screened.includes(t)) seedTo(t, { status: 'refused', reason: 'the free-model relevance screen kept it off this site\'s list (not this audience, or someone else\'s brand)' });
  }
  // 5. Optional top-10 read for the best can-be-#1 candidates (off without a key),
  //    then the lanes: about 2 of 3 can_be_one, 1 of 3 striking (config competition.lanes).
  const minOne = cfg.competition?.min_can_be_one ?? COMPETE_DEFAULTS.min_can_be_one;
  const forTop10 = [...screened].sort((a, b) => b.scores.can_be_one - a.scores.can_be_one || b.score - a.score);
  receipt.competition = await readTop10(cfg, forTop10, { L, now, fetchImpl, receipt });
  for (const t of screened) t.scores.can_be_one = canBeOneScore(t.signals, weights).score;
  screened = assignLanes(screened, laneRatio(cfg), minOne);
  for (const t of screened) {
    const one = canBeOneScore(t.signals, weights);
    if (t.lane === 'can_be_one') { t.lane = 'can_be_one'; t.score = one.score; t.reasons = one.reasons; }
    else {
      t.score = t.scores.striking;
      t.reasons = [t.signals.gsc_position ? `already ranks ${t.signals.gsc_position} in Search Console (${t.signals.gsc_impressions} impressions)` : 'autocomplete demand (google/bing)', ...(one.score >= minOne ? [`can-be-#1 score ${one.score} too (taken by the striking lane's turn)`] : one.reasons.length ? [`can-be-#1 evidence too thin (${one.score} < ${minOne})`] : [])];
    }
    if (t.priority) t.reasons = [`priority topic "${t.priority}" (find.priority_topics): built before other searches`, ...t.reasons];
    if (t.signals.comparison_pull && screen.comparison?.has(t)) t.comparison = true;
    if (t.comparison) t.reasons = [`comparison search: Search Console shows people choosing between options here (position ${t.signals.comparison_position}, ${t.signals.comparison_impressions} impressions); built after AI answer misses, before other searches`, ...t.reasons];
    if (t.seed) t.reasons = ['hand-given search (config seeds): a search ChatGPT runs before it recommends an app here; built after comparison searches, before priority topics', ...t.reasons];
    if (t.ai_miss_ids) t.reasons = ['AI answer miss: ChatGPT, Gemini or AI Overviews answer this without the site and no page fits; built first', ...t.reasons];
    if (!t.signals.top10) t.signals.top10 = receipt.sources.top10?.startsWith('not read') ? receipt.sources.top10 : 'not read: outside this run\'s top-10 budget';
  }
  strengthen.sort((a, b) => b.score - a.score);
  // Priority searches lead the list (and survive the max_targets cut); BUILD takes them first.
  // AI answer misses first, then priority searches.
  // v1.16.0: comparison searches the model confirmed come next, before priority topics.
  // v1.17.0: hand-given seeds come right after comparisons, before priority topics.
  const tier = (t) => (t.ai_miss_ids ? 0 : t.comparison ? 1 : t.seed ? 2 : t.priority ? 3 : 4);
  screened = [0, 1, 2, 3, 4].flatMap((n) => screened.filter((t) => tier(t) === n));
  const nPri = receipt.seeds.priority_topics;
  receipt.seeds.priority_targets = screened.filter((t) => t.priority).length;
  if (nPri && !receipt.seeds.priority_targets) receipt.notes.push(`NAMED NOTE [FIND_PRIORITY_EMPTY] the site's ${nPri} priority topic(s) produced no new search this week (${[...cands.values()].filter((c) => c.priority).length} candidate(s) before the site-coverage check and the relevance screen); the other topics still build`);
  if (!receipt.notes.length) delete receipt.notes;
  // What the comparison pull gave this week (the week report's `comparison` block).
  receipt.comparison = {
    pulled: receipt.sources.comparison_pull,
    candidates: cmpRows.length,
    confirmed: screen.notRead ? `not read: free-model screen (${screen.notRead}); no comparison priority this run` : screen.comparisonNotRead ? `not read: ${screen.comparisonNotRead}; no comparison priority this run` : screened.filter((t) => t.comparison).length,
    queued: screened.slice(0, cfg.find.max_targets).filter((t) => t.comparison).map((t) => t.query).slice(0, 20),
  };
  receipt.lanes = { ratio: laneRatio(cfg), can_be_one: screened.filter((t) => t.lane === 'can_be_one').length, striking: screened.filter((t) => t.lane === 'striking').length, weights };
  receipt.counts = { candidates: cands.size, targets: screened.length, strengthen_candidates: strengthen.length, dropped_shared_audience: droppedShared };
  const out = { schema: 'search-loop-targets-v1', site: cfg.site, week: receipt.week, generated_at: receipt.generated_at, sources: receipt.sources, targets: screened.slice(0, cfg.find.max_targets), strengthen: strengthen.slice(0, 50) };
  const idsOf = (list) => new Set(list.flatMap((t) => t.ai_miss_ids || []));
  const kept = idsOf(out.targets); const passed = idsOf(screened);
  for (const t of targets) for (const id of t.ai_miss_ids || []) {
    if (aiOutcome.has(id)) continue;
    aiOutcome.set(id, kept.has(id) ? { action: 'candidate', prompt: t.query } : passed.has(id) ? { action: 'skipped', reason: `past this week's ${cfg.find.max_targets}-search limit` } : { action: 'skipped', reason: 'the relevance screen kept it off this site\'s list' });
  }
  for (const m of aiMisses) if (!aiOutcome.has(m.id)) aiOutcome.set(m.id, { action: 'skipped', reason: 'dropped by FIND' });
  // Seeds: queued (on the list for BUILD), past the list's limit, or what happened above.
  const listed = new Set(out.targets);
  for (const t of screened) if (t.seed && !seedsOut.has(t.seed.key)) seedTo(t, listed.has(t) ? { status: 'queued', reason: 'on this week\'s list for BUILD' } : { status: 'queued', reason: `past this week's ${cfg.find.max_targets}-search limit; the next FIND lists it again` });
  for (const s of seedList(cfg)) if (!SEED_DONE.has(sbook.seeds[s.key]?.status) && !seedsOut.has(s.key)) seedsOut.set(s.key, { query: s.query, status: 'refused', reason: 'dropped by FIND (its words fold into another search on the list, or it failed the lexical checks)' });
  for (const [k, v] of seedsOut) setSeed(sbook, k, { ...v, at: centralDate(now) });
  if (seedsOut.size) saveSeedBook(L, sbook);
  receipt.seeds_given = seedList(cfg).length ? { configured: seedList(cfg).length, queued: out.targets.filter((t) => t.seed).length } : undefined;
  if (aiMisses.length) receipt.ai_misses = Object.fromEntries(aiOutcome);
  L.write('targets', out);
  L.write('receipt', receipt);
  return { ai_misses: aiOutcome, targets: out.targets.length, strengthen: out.strengthen.length, priority: receipt.seeds.priority_targets, sources: receipt.sources, notes: (receipt.notes || []).filter((n) => n.startsWith('NAMED ')), receipt };
}
