// DISTINCT INTENT GATE (her ruling, 3 Nov 2026: the search loop publishes only
// distinct pages). Five sites lost most of their Google exposure under
// thousands of near-identical template pages and recovered only after cutting
// to a few dozen to a few hundred distinct pages. So before a new page is
// written, its search is compared with every page the site already has
// (titles, H1s, the engine's own question pages and the site's sitemap). Same
// intent = no new page: a "strengthen <existing URL>" brief goes on the
// existing strengthen path instead, and the decision and the matched URL are
// logged in the week report.
//
// Same intent means any one of:
//   - same wording: identical intent words after normalising (stop words,
//     intent verbs like "how to / avoid / tips", plurals and -ing removed);
//   - high token overlap: Jaccard of the intent words >= distinct.jaccard (0.6);
//   - one names the other plus modifiers: every intent word of the shorter
//     (>= distinct.containment_min_words, 3) is in the longer — the template
//     shape ("wedding budget spreadsheet" + "for a small wedding");
//   - same answer (after drafting): the draft's direct answer shares
//     >= distinct.same_answer (0.5) of its 3-word shingles with an engine page's.
// Conservative by design: when in doubt the site gets a stronger existing page,
// not one more near-twin.
import fs from 'node:fs';
import path from 'node:path';
import { contentWords, shingles, jaccard } from './util.mjs';
import { INTENT_VERBS, stem } from './find.mjs';

import { DISTINCT_DEFAULTS } from './defaults.mjs';
export { DISTINCT_DEFAULTS };

export function siteWordsOf(cfg) { return new Set(contentWords(cfg.site_name || '')); }

// Intent words: content words minus intent verbs and the site's own name, stemmed.
export function intentWords(text, siteWords = new Set()) {
  return new Set(contentWords(text).filter((w) => !INTENT_VERBS.has(w) && !siteWords.has(w)).map(stem).filter((w) => w.length > 1));
}

// Pure. a, b: intent-word sets. Returns { by, score } or null.
export function sameIntent(a, b, th = DISTINCT_DEFAULTS) {
  if (!a.size || !b.size) return null;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  if (inter === a.size && inter === b.size) return { by: 'same wording', score: 1 };
  const jac = inter / (a.size + b.size - inter);
  if (jac >= th.jaccard) return { by: `high token overlap (${jac.toFixed(2)} >= ${th.jaccard})`, score: jac };
  const small = Math.min(a.size, b.size);
  if (small >= th.containment_min_words && inter === small) return { by: `same ${small} intent words plus modifiers`, score: inter / Math.max(a.size, b.size) };
  return null;
}

const routeOfUrl = (cfg, u) => { try { const x = new URL(u, cfg.base_url); return x.origin === cfg.base_url ? x.pathname : null; } catch { return null; } };
const slugWords = (route) => decodeURIComponent(String(route).replace(/\.html?$/, '').split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');

// Local sitemap files: distinct.sitemap_files, or every sitemap*.xml at the repo root.
export function sitemapRoutes(cfg) {
  const root = cfg.root;
  let files = cfg.distinct?.sitemap_files;
  if (!Array.isArray(files)) { try { files = fs.readdirSync(root).filter((f) => /^sitemap.*\.xml$/i.test(f)); } catch { files = []; } }
  const out = new Set();
  for (const f of files) {
    let xml; try { xml = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) { if (/\.xml$/i.test(m[1])) continue; const r = routeOfUrl(cfg, m[1]); if (r) out.add(r); }
  }
  return [...out];
}

// Everything the site already answers. index: buildIndex(); book: pages.json.
export function corpusFor(cfg, index, book) {
  const sw = siteWordsOf(cfg);
  const out = [];
  const seen = new Set();
  const add = (route, texts, kind, extra = {}) => {
    const sets = texts.filter(Boolean).map((t) => ({ text: t, words: intentWords(t, sw) })).filter((x) => x.words.size);
    if (!sets.length) return;
    out.push({ route, url: cfg.base_url + route, kind, sets, ...extra });
    seen.add(route);
  };
  for (const p of book?.pages || []) if (p.status === 'live') add(p.route, [p.query], 'engine', { slug: p.slug });
  for (const p of index || []) add(p.route, [p.title, p.h1], 'page', { protected: p.protected });
  for (const r of sitemapRoutes(cfg)) if (!seen.has(r) && !seen.has(r.replace(/\/$/, '')) && !seen.has(r + '/')) add(r, [slugWords(r)], 'sitemap');
  return out;
}

// First existing page with the same intent as `text`, preferring the strongest match.
export function matchIntent(cfg, text, corpus, { exceptRoute } = {}) {
  const th = { ...DISTINCT_DEFAULTS, ...(cfg.distinct || {}) };
  const a = intentWords(text, siteWordsOf(cfg));
  let best = null;
  for (const c of corpus) {
    if (c.route === exceptRoute) continue;
    for (const s of c.sets) {
      const m = sameIntent(a, s.words, th);
      if (m && (!best || m.score > best.score)) best = { url: c.url, route: c.route, kind: c.kind, matched_text: s.text, by: m.by, score: m.score };
    }
  }
  return best;
}

// Same answer: the draft's direct answer against every live engine page's stored draft.
export function answerShingles(text) { return shingles(text, 3); }
export function matchAnswer(cfg, answer, answers) {
  const th = { ...DISTINCT_DEFAULTS, ...(cfg.distinct || {}) };
  const sh = answerShingles(answer);
  let best = null;
  for (const a of answers) {
    const j = jaccard(sh, a.sh);
    if (j >= th.same_answer && (!best || j > best.score)) best = { url: a.url, route: a.route, kind: 'engine', matched_text: a.text.slice(0, 120), by: `same answer (${j.toFixed(2)} >= ${th.same_answer})`, score: j };
  }
  return best;
}

export function engineAnswers(cfg, L, book) {
  const out = [];
  for (const p of book?.pages || []) {
    if (p.status !== 'live') continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(L.dir, 'drafts', `${p.slug}.json`), 'utf8'));
      if (d.direct_answer) out.push({ route: p.route, url: p.url || cfg.base_url + p.route, text: d.direct_answer, sh: answerShingles(d.direct_answer) });
    } catch { /* no stored draft: the intent check above still covers it */ }
  }
  return out;
}

// Count of distinct intents among the live engine pages (near-twins count once).
export function distinctCount(cfg, pages) {
  const sw = siteWordsOf(cfg);
  const th = { ...DISTINCT_DEFAULTS, ...(cfg.distinct || {}) };
  const reps = [];
  for (const p of pages) {
    const w = intentWords(p.query, sw);
    if (!reps.some((r) => sameIntent(w, r, th))) reps.push(w);
  }
  return reps.length;
}
