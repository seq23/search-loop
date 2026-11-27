// Hand-given searches (v1.17.0, her yes 27 Nov 2026: "yes turn those searches into pages").
// A site lists, in config `seeds`, the searches ChatGPT runs before it recommends an app in the
// site's category (captured from real ChatGPT answers). FIND adds each one as a candidate that
// goes through every check a found search goes through (page size, find.exclude_words, the
// site-coverage and sibling checks, the free-model relevance screen, the distinct-intent gate,
// the page gate, the product-claim check); a seed that survives is built right after the
// Search Console comparison searches and before the priority topics. A seed with the same
// intent as a live engine page strengthens that page instead of making a second one (CHECK);
// one that a hand-built page already answers is recorded as answered there (the engine never
// edits hand-built pages). Every seed's outcome is in data/search-loop/seeds.json and in the
// week report's `seeds` block.
import { norm } from './util.mjs';
import { intentKey } from './find.mjs';

export const SEEDS_SCHEMA = 'search-loop-seeds-v1';
export const MAX_SEEDS = 25;
// A seed that will never be acted on again. Anything else (queued, strengthen pending, a drop
// that retries) is picked up by the next FIND or CHECK.
export const DONE = new Set(['built', 'strengthened', 'answered_by']);
export const STRENGTHEN_TRIES = 3;

// The site's seeds as {query, wants, key}; a string seed has no wants.
export function seedList(cfg) {
  return (cfg.seeds || []).map((s) => (typeof s === 'string' ? { query: s } : s)).map((s) => ({
    query: norm(s.query),
    wants: (s.wants || []).map((w) => String(w).trim()).filter(Boolean),
  })).filter((s) => s.query).map((s) => ({ ...s, key: intentKey(s.query) }));
}

export function checkSeeds(c) {
  const p = [];
  if (c.seeds === undefined) return p;
  if (!Array.isArray(c.seeds) || c.seeds.length > MAX_SEEDS) return [`seeds: a list of at most ${MAX_SEEDS} searches`];
  c.seeds.forEach((s, i) => {
    const q = typeof s === 'string' ? s : s?.query;
    const words = String(q || '').trim().split(/\s+/).filter(Boolean).length;
    if (typeof q !== 'string' || q.trim().length < 8 || q.length > 120 || words < 2 || words > 14) p.push(`seeds[${i}]: a search of 2-14 words, 8-120 characters (as a string or {query, wants})`);
    if (typeof s === 'object' && s !== null && s.wants !== undefined && !(Array.isArray(s.wants) && s.wants.length <= 8 && s.wants.every((w) => typeof w === 'string' && w.trim().length >= 2 && w.length <= 60))) p.push(`seeds[${i}].wants: up to 8 short feature words the searcher asked for (e.g. "no account")`);
  });
  // A seed page tells a person which app to pick, so it must know what this one really does.
  if (c.seeds.length && !(Array.isArray(c.product?.facts) && c.product.facts.length)) p.push('seeds need product.facts: what the site\'s product really does today (a seed page never claims a feature it lacks)');
  return p;
}

// ---- ledger: seeds.json ------------------------------------------------------
// seeds[<intent key>] = { query, status, at, url?, route?, reason?, tries? }
export function seedBook(L) {
  const j = L.read('seeds', null) || {};
  return { schema: SEEDS_SCHEMA, seeds: j.seeds && typeof j.seeds === 'object' ? j.seeds : {} };
}
export const saveSeedBook = (L, book) => L.write('seeds', book);

export function setSeed(book, key, rec) {
  const cur = book.seeds[key];
  if (cur && DONE.has(cur.status)) return false;
  book.seeds[key] = { ...(cur || {}), ...rec };
  return true;
}

// Mark a seed in the ledger from BUILD or CHECK by its search (no-op for a non-seed).
export function markSeed(L, cfg, query, rec) {
  const key = intentKey(query);
  if (!seedList(cfg).some((s) => s.key === key)) return false;
  const book = seedBook(L);
  const ok = setSeed(book, key, { query: norm(query), ...rec });
  if (ok) saveSeedBook(L, book);
  return ok;
}

// The week report's `seeds` block (additive, v1.17.0): every configured seed's latest outcome.
export function seedsBlock(cfg, L) {
  const list = seedList(cfg);
  if (!list.length) return 'not read: this site has no seeds in its config';
  const book = seedBook(L);
  const out = { configured: list.length, built: [], strengthened: [], answered_by: [], refused: [], queued: [] };
  for (const s of list) {
    const r = book.seeds[s.key];
    if (!r) { out.queued.push({ query: s.query, reason: 'FIND has not read this seed yet' }); continue; }
    if (r.status === 'built') out.built.push({ query: s.query, url: r.url, at: r.at });
    else if (r.status === 'strengthened') out.strengthened.push({ query: s.query, url: r.url, at: r.at });
    else if (r.status === 'answered_by') out.answered_by.push({ query: s.query, url: r.url, reason: r.reason || 'an existing page answers it' });
    else if (r.status === 'refused') out.refused.push({ query: s.query, reason: r.reason || 'refused' });
    else out.queued.push({ query: s.query, reason: r.reason || (r.status === 'strengthen' ? `strengthens ${r.url} at the next CHECK` : 'queued for BUILD') });
  }
  return out;
}

export function checkSeedsBlock(x) {
  if (typeof x === 'string') return x.startsWith('not read: ') ? [] : ['seeds must be "not read: <reason>" or the seeds block'];
  const p = [];
  if (!x || !Number.isInteger(x.configured)) return ['seeds.configured must be a count'];
  for (const k of ['built', 'strengthened']) if (!Array.isArray(x[k]) || x[k].some((s) => typeof s?.query !== 'string' || !/^https?:\/\//.test(String(s.url)))) p.push(`seeds.${k} must be a list of {query, url}`);
  for (const k of ['answered_by']) if (!Array.isArray(x[k]) || x[k].some((s) => typeof s?.query !== 'string' || !/^https?:\/\//.test(String(s.url)) || !s.reason)) p.push(`seeds.${k} must be a list of {query, url, reason}`);
  for (const k of ['refused', 'queued']) if (!Array.isArray(x[k]) || x[k].some((s) => typeof s?.query !== 'string' || typeof s.reason !== 'string' || !s.reason)) p.push(`seeds.${k} must be a list of {query, reason}`);
  if (!p.length && ['built', 'strengthened', 'answered_by', 'refused', 'queued'].reduce((n, k) => n + x[k].length, 0) !== x.configured) p.push('seeds: every configured seed is in exactly one list');
  return p;
}
