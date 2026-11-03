// Competition (v1.6.0, her ruling 3 Nov 2026: "sometimes we find where we can
// just be 1 or closer to 1 and move forward"). Two lanes per site:
//   can_be_one  — searches where the site can be #1 straight away, picked by a
//                 competition score (about 2 of every 3 new pages);
//   striking    — the old method: rows the site already ranks 8-30 for (about 1 in 3).
// Signals, all $0: the site's own Search Console ("easy-win neighbours",
// "nobody answers this exact question"), and an optional top-10 read through a
// provider (Brave Search API) that is off unless its key exists. Never Google
// scraping. A signal not read is written "not read: <reason>".
import { COMPETE_DEFAULTS } from './defaults.mjs';
import { contentWords, norm, centralDate, isoWeek, progress } from './util.mjs';

export const LANES = ['can_be_one', 'striking'];
export { COMPETE_DEFAULTS };
export const WEIGHT_DEFAULTS = { neighbour: 35, unanswered: 30, weak_top10: 40, demand: 10 };
export const WEIGHT_BOUNDS = [0.5, 2]; // learned weight stays within 0.5x-2x its default
export const LEARN = { min_samples: 5, step: 0.1, good: 0.5, poor: 0.2 };
export const EASY_WIN = { max_position: 3, max_impressions: 50, fast_days: 14 };
export const NO_BRAVE_KEY = 'not read: no BRAVE_SEARCH_API_KEY';
export const BUDGET_USED = 'not read: Brave free budget used';
// Her rule (3 Nov 2026): "starting with free credits and not going above $0".
// Brave gives $5 of credit a month at $5 per 1,000 web searches = 1,000 searches.
// The fleet uses at most 70% of it: the share is split over FLEET.sites slots
// (12 callers today, room for 2 more), and no site config can raise its share.
export const FLEET = { free_requests_per_month: 1000, max_share: 0.7, sites: 14 };
export const SITE_MONTHLY_CEILING = Math.floor((FLEET.free_requests_per_month * FLEET.max_share) / FLEET.sites); // 50
// Brave's quota headers: x-ratelimit-limit "50, 0" / remaining "49, 0" / reset "1, 2368531"
// (per second, per month). On the credit plan the monthly figure reads 0 (no
// fixed quota); when Brave does send a monthly limit, the run stops at 30% left.
export function parseRateHeaders(h) {
  const get = (k) => (typeof h?.get === 'function' ? h.get(k) : h?.[k]);
  const nums = (k) => String(get(k) ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  const limit = nums('x-ratelimit-limit'); const remaining = nums('x-ratelimit-remaining'); const reset = nums('x-ratelimit-reset');
  if (!limit.length && !remaining.length) return null;
  return { month_limit: limit[1] ?? null, month_remaining: remaining[1] ?? null, month_reset_s: reset[1] ?? null, policy: get('x-ratelimit-policy') || null };
}
export function headersSayStop(hd) {
  return Boolean(hd && hd.month_limit > 0 && hd.month_remaining != null && hd.month_remaining <= hd.month_limit * (1 - FLEET.max_share));
}

const stem = (w) => w.replace(/(ing|ers|er|ed|es|s)$/, '');
const stems = (q) => new Set(contentWords(q).map(stem));
export function similarity(a, b) {
  const A = stems(a); const B = stems(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}

// --- Search Console signals ------------------------------------------------

// Searches the site already won with little competition: top 3 with few
// impressions (a quiet niche), or an engine page in the top 3 at its 2-week check.
export function easyWins(measured = [], pages = []) {
  const out = new Map();
  for (const m of measured) if (m.position <= EASY_WIN.max_position && (m.impressions || 0) <= EASY_WIN.max_impressions) out.set(norm(m.query), { query: norm(m.query), why: `top ${Math.round(m.position)} with ${m.impressions} impressions` });
  for (const p of pages) {
    const w2 = p.checks?.w2;
    if (w2?.source === 'search_console' && typeof w2.position === 'number' && w2.position <= EASY_WIN.max_position) out.set(norm(p.query), { query: norm(p.query), why: `engine page in the top ${Math.round(w2.position)} within ${EASY_WIN.fast_days} days` });
  }
  return [...out.values()];
}

// Close variants of an easy win: the same search in each of the site's other places.
export function placeVariants(wins, places = []) {
  const P = places.map(norm).filter(Boolean);
  const out = [];
  for (const w of wins) {
    const here = P.find((p) => (' ' + w.query + ' ').includes(' ' + p + ' '));
    if (!here) continue;
    for (const other of P) if (other !== here) out.push({ query: w.query.replace(here, other), of: w.query });
  }
  return out;
}

// The can-be-#1 evidence for one candidate, from the site's own data.
export function gscCompetition(c, { wins = [], measured = [], covered = 0 } = {}) {
  const s = {};
  let best = null;
  for (const w of wins) {
    if (norm(w.query) === norm(c.query)) continue;
    const sim = similarity(c.query, w.query);
    if (sim >= 0.5 && (!best || sim > best.sim)) best = { sim: Math.round(sim * 100) / 100, of: w.query, why: w.why };
  }
  if (best) s.neighbour = best;
  const words = contentWords(c.query).length;
  if (words >= 4 && covered < 0.5) {
    // "parts" of the phrase the site already holds at a good position
    const parts = measured.filter((m) => m.position <= 10 && [...stems(m.query)].filter((x) => stems(c.query).has(x)).length >= 2);
    // both halves, or it is not evidence: no page of ours covers it AND our own
    // Search Console holds its parts at a good position (low competition there).
    if (parts.length) s.unanswered = { words, covered: Math.round(covered * 100) / 100, parts_best_position: Math.round(Math.min(...parts.map((m) => m.position)) * 10) / 10, parts_rows: parts.length };
  }
  return s;
}

// --- Top-10 read (optional provider) ---------------------------------------

export const DIRECTORIES = ['psychologytoday.com', 'zocdoc.com', 'yelp.com', 'thumbtack.com', 'angi.com', 'angieslist.com', 'homeadvisor.com', 'healthgrades.com', 'vitals.com', 'yellowpages.com', 'superpages.com', 'bbb.org', 'nextdoor.com', 'manta.com', 'expertise.com', 'chamberofcommerce.com', 'mapquest.com', 'tripadvisor.com', 'houzz.com', 'care.com', 'weddingwire.com', 'theknot.com', 'avvo.com', 'findlaw.com', 'lawyers.com', 'martindale.com', 'justia.com', 'goodtherapy.org', 'therapyden.com', 'opencare.com', 'sharecare.com', 'birdeye.com', 'porch.com', 'bark.com', 'networx.com', 'groupon.com', 'eventbrite.com', 'peerspace.com'];
export const FORUMS = ['reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'answers.yahoo.com', 'facebook.com', 'tiktok.com', 'pinterest.com', 'medium.com'];
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const onList = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
const isForumHost = (h) => onList(h, FORUMS) || /^(forum|forums|community|answers)\./.test(h);
const OLD_YEARS = 3;

// Plain rules over the top 10. weakness 0..1: 1 = nothing there answers it well.
export function scoreTop10(results = [], { query, places = [], now = new Date() } = {}) {
  const top = results.slice(0, 10);
  const counts = { results: top.length, directories: 0, forums: 0, off_target_national: 0, thin_or_old: 0, exact_answer: 0 };
  if (!top.length) return { weakness: 1, counts, reasons: ['top 10 is empty'] };
  const P = places.map(norm).filter(Boolean);
  const place = P.find((p) => (' ' + norm(query) + ' ').includes(' ' + p + ' '));
  const qs = stems(query);
  let weak = 0; let total = 0;
  top.forEach((r, i) => {
    const h = hostOf(r.url);
    const text = norm(`${r.title || ''} ${r.description || ''} ${r.url || ''}`);
    const w = i < 3 ? 2 : 1; // the top 3 matter most
    total += w;
    const tStems = stems(r.title || '');
    const exact = qs.size > 0 && [...qs].filter((x) => tStems.has(x)).length / qs.size >= 0.85;
    let isWeak = false;
    if (onList(h, DIRECTORIES)) { counts.directories++; isWeak = true; }
    else if (isForumHost(h)) { counts.forums++; isWeak = true; }
    else if (place && !(' ' + text + ' ').includes(' ' + place + ' ')) { counts.off_target_national++; isWeak = true; }
    const age = r.page_age || r.age_date || null;
    const years = age && !Number.isNaN(Date.parse(age)) ? (now - Date.parse(age)) / (365.25 * 86400000) : null;
    if ((years != null && years > OLD_YEARS) || String(r.description || '').length < 50) { counts.thin_or_old++; if (!exact) isWeak = true; }
    if (exact) { counts.exact_answer++; if (!onList(h, DIRECTORIES) && !isForumHost(h)) isWeak = false; }
    if (isWeak) weak += w;
  });
  const weakness = Math.round((weak / total) * 100) / 100;
  const reasons = [`top 10: ${counts.directories} directories, ${counts.forums} forums, ${counts.off_target_national} off-target national, ${counts.thin_or_old} thin or old, ${counts.exact_answer} answer the exact question`];
  return { weakness, counts, reasons };
}

// Provider interface: { name, read(query) -> { ok, results:[{url,title,description,page_age}] } | { ok:false, reason } }
export function braveProvider({ key, fetchImpl = fetch, country = 'us' }) {
  return {
    name: 'brave',
    host: 'api.search.brave.com',
    async read(q) {
      let res;
      try { res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&country=${country}&safesearch=moderate`, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(15000) }); } catch (e) { return { ok: false, reason: e.message }; }
      const headers = parseRateHeaders(res.headers);
      // 402 = credit gone, 429 = quota: both end Brave reads for the month.
      if (!res.ok) return { ok: false, reason: `http ${res.status}`, headers, stop: [401, 402, 403, 429].includes(res.status), budgetUsed: [402, 429].includes(res.status) };
      let json = null; try { json = await res.json(); } catch { return { ok: false, reason: 'answer was not JSON', headers }; }
      const r = { json };
      return { ok: true, headers, results: (r.json?.web?.results || []).map((x) => ({ url: x.url, title: x.title, description: x.description, page_age: x.page_age || null })) };
    },
  };
}

export function top10Provider(cfg, { env = process.env, fetchImpl = fetch } = {}) {
  const p = cfg.competition?.top10?.provider || 'brave';
  if (p === 'none') return { notRead: 'not read: top-10 provider is off in this site\'s config' };
  if (p !== 'brave') return { notRead: `not read: unknown top-10 provider "${p}"` };
  const key = String(env.BRAVE_SEARCH_API_KEY || '').trim();
  if (!key) return { notRead: NO_BRAVE_KEY };
  return { provider: braveProvider({ key, fetchImpl }) };
}

// Per-site budget, kept in the ledger (serp-budget.json) so the fleet stays in
// the free monthly credit: daily and monthly ceilings, whichever is lower.
export function budgetLeft(book, cfg, now = new Date()) {
  const t = { ...COMPETE_DEFAULTS.top10, ...(cfg.competition?.top10 || {}) };
  const day = centralDate(now); const month = day.slice(0, 7);
  if (book?.stopped_month === month) return 0; // Brave said the budget is used: done until next month
  if (headersSayStop(book?.last_headers) && book?.last_headers_month === month) return 0;
  const usedDay = book?.days?.[day] || 0; const usedMonth = book?.months?.[month] || 0;
  const monthly = Math.min(t.monthly_budget, SITE_MONTHLY_CEILING); // a config can lower, never raise
  const daily = Math.min(t.daily_budget, monthly);
  return Math.max(0, Math.min(daily - usedDay, monthly - usedMonth));
}
export function spend(book, now = new Date(), n = 1) {
  const day = centralDate(now); const month = day.slice(0, 7);
  const b = { schema: 'search-loop-serp-budget-v1', days: {}, months: {}, ...(book || {}) };
  b.days = { ...b.days, [day]: (b.days[day] || 0) + n };
  b.months = { ...b.months, [month]: (b.months[month] || 0) + n };
  b.days = Object.fromEntries(Object.entries(b.days).sort().slice(-40));
  b.months = Object.fromEntries(Object.entries(b.months).sort().slice(-13));
  return b;
}

// Read the top 10 for the best can-be-#1 candidates, within budget.
export async function readTop10(cfg, cands, { L, now, fetchImpl, env = process.env, receipt }) {
  const pv = top10Provider(cfg, { env, fetchImpl });
  if (pv.notRead) { receipt.sources.top10 = pv.notRead; return pv.notRead; }
  let book = L.read('serp_budget', null);
  let left = budgetLeft(book, cfg, now);
  const host = pv.provider.host;
  receipt.hosts[host] = { calls: 0, ok: 0, failed: 0, cost_usd: 0 };
  if (!left) { receipt.sources.top10 = `${BUDGET_USED} (this site's share for today or this month; at most ${SITE_MONTHLY_CEILING}/month, the fleet stays under ${FLEET.max_share * 100}% of the free credit)`; return receipt.sources.top10; }
  const month = centralDate(now).slice(0, 7);
  const places = cfg.local ? [cfg.local.city, ...(cfg.local.neighbourhoods || [])] : [];
  let read = 0; let lastFail = null;
  for (const c of cands) {
    if (left <= 0) break;
    progress('find', `top-10 read ${read + 1}: "${c.query}"`);
    const r = await pv.provider.read(c.query);
    left--; receipt.hosts[host].calls++; book = spend(book, now);
    if (r.headers) { book.last_headers = r.headers; book.last_headers_month = month; }
    if (r.budgetUsed) book.stopped_month = month;
    if (headersSayStop(r.headers) || r.budgetUsed) { if (r.ok) { receipt.hosts[host].ok++; read++; c.signals.top10 = { provider: pv.provider.name, ...scoreTop10(r.results, { query: c.query, places, now }) }; } else receipt.hosts[host].failed++; lastFail = BUDGET_USED.replace('not read: ', ''); left = 0; break; }
    if (!r.ok) { receipt.hosts[host].failed++; lastFail = r.reason; c.signals.top10 = `not read: ${pv.provider.name} ${r.reason}`; if (r.stop) break; continue; }
    receipt.hosts[host].ok++; read++;
    c.signals.top10 = { provider: pv.provider.name, ...scoreTop10(r.results, { query: c.query, places, now }) };
  }
  L.write('serp_budget', book);
  receipt.sources.top10 = read ? `ok: ${read} top-10 read(s) via ${pv.provider.name}${lastFail === 'Brave free budget used' ? '; then Brave free budget used' : ''}` : (lastFail === 'Brave free budget used' ? BUDGET_USED : `not read: ${pv.provider.name} ${lastFail || 'no read'}`);
  return receipt.sources.top10;
}

// --- Scores and lanes -------------------------------------------------------

export function weightsOf(L) {
  const w = L?.read('lane_weights', null);
  return { ...WEIGHT_DEFAULTS, ...(w?.weights || {}) };
}

export function canBeOneScore(sig, weights = WEIGHT_DEFAULTS) {
  const w = { ...WEIGHT_DEFAULTS, ...weights };
  let score = 0; const reasons = [];
  if (sig.neighbour) { score += w.neighbour * sig.neighbour.sim; reasons.push(`easy-win neighbour of "${sig.neighbour.of}" (${sig.neighbour.why})`); }
  if (sig.unanswered) { score += w.unanswered; reasons.push(`no site page answers this ${sig.unanswered.words}-word question, and the site holds its parts at position ${sig.unanswered.parts_best_position}`); }
  if (sig.top10 && typeof sig.top10 === 'object') { score += w.weak_top10 * sig.top10.weakness; reasons.push(`weak top 10 (${sig.top10.weakness}): ${sig.top10.reasons[0].replace(/^top 10: /, '')}`); }
  if ((sig.google_suggest || sig.bing_suggest || sig.gsc_impressions) && score > 0) { score += w.demand; reasons.push('people search it (autocomplete or impressions)'); }
  return { score: Math.round(score * 10) / 10, reasons };
}

export function laneRatio(cfg) {
  const l = { ...COMPETE_DEFAULTS.lanes, ...(cfg.competition?.lanes || {}) };
  return { can_be_one: l.can_be_one, striking: l.striking };
}

// The lane behind its share goes next; ties go to can_be_one. An empty lane
// hands its turn to the other one, so the day's quota is never wasted.
export function pickLane(counts, ratio, available = { can_be_one: true, striking: true }) {
  const open = LANES.filter((l) => available[l] && ratio[l] > 0);
  const pool = open.length ? open : LANES.filter((l) => available[l]);
  if (!pool.length) return null;
  return pool.reduce((best, l) => ((counts[l] || 0) / (ratio[l] || 1) < (counts[best] || 0) / (ratio[best] || 1) ? l : best), pool[0]);
}

// FIND's lane assignment: two ranked lists (can-be-#1 score, striking score);
// each lane in turn takes its best search not yet taken by the other, so a
// search the site already ranks 8-30 for is never starved out of the striking lane.
export function assignLanes(targets, ratio, minOne) {
  const one = targets.filter((t) => t.scores.can_be_one >= minOne).sort((a, b) => b.scores.can_be_one - a.scores.can_be_one);
  const str = [...targets].sort((a, b) => b.scores.striking - a.scores.striking);
  const taken = new Set(); const out = []; const counts = { can_be_one: 0, striking: 0 };
  const head = (list) => { while (list.length && taken.has(list[0])) list.shift(); return list[0]; };
  for (;;) {
    const avail = { can_be_one: Boolean(head(one)), striking: Boolean(head(str)) };
    const l = pickLane(counts, ratio, avail);
    if (!l) break;
    const t = (l === 'can_be_one' ? one : str).shift();
    taken.add(t); t.lane = l; counts[l]++; out.push(t);
  }
  return out;
}

// A live queue for BUILD: the next target comes from the lane behind its share
// of the pages actually made (history + this run), so skips don't skew the split.
export function laneQueue(targets, ratio, made) {
  const q = { can_be_one: targets.filter((t) => t.lane === 'can_be_one'), striking: targets.filter((t) => t.lane !== 'can_be_one') };
  return {
    get size() { return q.can_be_one.length + q.striking.length; },
    next() {
      const l = pickLane(made, ratio, { can_be_one: q.can_be_one.length > 0, striking: q.striking.length > 0 });
      return l ? q[l].shift() : undefined;
    },
  };
}

// --- Learning ---------------------------------------------------------------

const measuredChecks = (p) => Object.entries(p.checks || {}).filter(([k, c]) => ['w2', 'w4', 'w8'].includes(k) && c?.source === 'search_console');
export const reachedTop3 = (p) => measuredChecks(p).some(([, c]) => typeof c.position === 'number' && c.position <= 3);

// Hit rate per lane: of the pages measured at 2/4/8 weeks, how many reached the top 3.
export function laneStats(pages = []) {
  const out = {};
  for (const l of LANES) {
    const mine = pages.filter((p) => (p.lane || 'striking') === l && p.status !== 'pending_approval' && p.published_at);
    const measured = mine.filter((p) => measuredChecks(p).length);
    const top3 = measured.filter(reachedTop3).length;
    out[l] = { pages: mine.length, measured: measured.length, top3, hit_rate: measured.length ? Math.round((top3 / measured.length) * 100) / 100 : 'not read: no page in this lane has reached its 2-week check yet' };
  }
  return out;
}

const SIGNAL_OF = { neighbour: /^easy-win neighbour/, unanswered: /^no site page answers/, weak_top10: /^weak top 10/ };

// Weekly, per site: each can-be-#1 signal's weight moves 10% up or down with
// how often pages picked on it reached the top 3, within 0.5x-2x its default.
export function learnWeights(pages, current, { week } = {}) {
  const weights = { ...WEIGHT_DEFAULTS, ...(current?.weights || {}) };
  if (current?.week === week) return { weights, changes: [], week, log: current.log || [] };
  const picked = pages.filter((p) => p.lane === 'can_be_one' && measuredChecks(p).length);
  const changes = [];
  for (const [k, re] of Object.entries(SIGNAL_OF)) {
    const withIt = picked.filter((p) => (p.reasons || []).some((r) => re.test(r)));
    if (withIt.length < LEARN.min_samples) continue;
    const rate = withIt.filter(reachedTop3).length / withIt.length;
    const dir = rate >= LEARN.good ? 1 : rate < LEARN.poor ? -1 : 0;
    if (!dir) continue;
    const [lo, hi] = WEIGHT_BOUNDS.map((b) => b * WEIGHT_DEFAULTS[k]);
    const to = Math.round(Math.min(hi, Math.max(lo, weights[k] * (1 + dir * LEARN.step))) * 10) / 10;
    if (to === weights[k]) continue;
    changes.push({ week, signal: k, from: weights[k], to, why: `${Math.round(rate * 100)}% of ${withIt.length} can-be-#1 pages picked on it reached the top 3` });
    weights[k] = to;
  }
  return { weights, changes, week, log: [...(current?.log || []), ...changes].slice(-52) };
}

export function weekOf(now) { return isoWeek(now); }
