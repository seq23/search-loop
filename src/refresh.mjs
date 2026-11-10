// REFRESH (v1.10.0): real freshness on question pages, never a fake date.
//
// Owner goal, 10 Nov 2026: every page of hers is re-checked every 30-90 days at $0. Risk rule
// R-ADV-12 (FTC Act s5, no fake freshness): a page's "Updated" date and lastmod move ONLY when what it
// says changed. Per due page, two real changes are possible:
//   1. Sources re-checked and fixed: every fact's source is fetched again; a source that is gone
//      (404, 410 or unreachable, on two tries) takes its fact off the page, as long as a sourced fact
//      remains (else the page is left and the note says so).
//   2. One new real-search question: a Search Console query (28 days) that lands on the page and that
//      no heading or FAQ on it answers yet becomes one FAQ entry, written by a free model from the
//      page's own words only (no new numbers, names or links), and kept only if the gate passes.
// Nothing changed -> the page is recorded as checked and its file, hash and dates are left alone.
// A change -> re-rendered with `modified: today`, snapshotted, and `modified_at` set on the page entry
// (sites read `modified_at || published_at` for lastmod).
//
// Pace: ceil(live / PACE_DAYS) pages a run (at most MAX_PER_RUN), oldest first, never one checked or
// changed within MIN_DAYS. Frozen sites and pages mid-strengthen are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { searchAnalytics, dateDaysAgo } from './gsc.mjs';
import { daysBetween, sha256, fetchText, norm, contentWords, pastSoft, progress } from './util.mjs';
import { render } from './render.mjs';
import { gate } from './gate.mjs';
import { parseJsonAnswer } from './llm.mjs';

export const MIN_DAYS = 30;
export const PACE_DAYS = 45;
export const MAX_PER_RUN = 3;
export const MAX_FAQ = 8;
const GONE = (s) => s === 404 || s === 410 || s === 0;

export const lastTouched = (p) => [p.refreshed?.at, p.modified_at, p.strengthen?.at, p.reshaped?.at, p.published_at].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort().at(-1);

/** The pages due today, oldest first, and how many this run takes. Pure. */
export function duePages(live, today) {
  const due = live
    .filter((p) => !(p.strengthen && !p.strengthen.verdict))
    .filter((p) => lastTouched(p) && daysBetween(lastTouched(p), today) >= MIN_DAYS)
    .sort((a, b) => lastTouched(a).localeCompare(lastTouched(b)) || a.route.localeCompare(b.route));
  return { due, take: Math.min(MAX_PER_RUN, Math.max(1, Math.ceil(live.length / PACE_DAYS))) };
}

/** Facts whose source is gone on two tries are dropped, if one sourced fact stays. */
export async function recheckSources(facts, fetchImpl = fetch) {
  const kept = []; const gone = [];
  for (const f of facts) {
    if (!f.source_url) { kept.push(f); continue; }
    const r = await fetchText(f.source_url, { fetchImpl, timeoutMs: 15000, retries: 1, headers: { 'user-agent': 'Mozilla/5.0 (compatible; search-loop source check; +https://github.com/seq23/search-loop)' } });
    if (GONE(r.status)) gone.push(f); else kept.push({ ...f, checked_status: r.status });
  }
  if (!gone.length) return { facts, gone: [] };
  if (!kept.some((f) => f.source_url)) return { facts, gone: [], left: `every source is gone (${gone.map((f) => f.source_url).join(', ')}); left for a rewrite` };
  return { facts: kept, gone };
}

/** The page's real searches that nothing on it answers yet, best first. Pure. */
export function openQueries(draft, rows) {
  const asked = [draft.h1, ...(draft.sections || []).map((s) => s.heading), ...(draft.faq || []).map((f) => f.q)].map((t) => new Set(contentWords(t)));
  const covered = (q) => { const w = contentWords(q); if (w.length < 2) return true; return asked.some((a) => w.filter((x) => a.has(x)).length / w.length >= 0.75); };
  return rows.filter((r) => norm(r.query).split(' ').length >= 3 && r.impressions > 0 && !covered(r.query))
    .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
}

/** Problems with a drafted FAQ entry: only the page's own facts. Pure. */
export function entryProblems(entry, draft, query) {
  const out = [];
  const q = String(entry?.q || '').trim(); const a = String(entry?.a || '').trim();
  if (!q.endsWith('?')) out.push('the question must end with "?"');
  const want = contentWords(query); const has = new Set(contentWords(q));
  if (want.length && want.filter((w) => has.has(w)).length / want.length < 0.5) out.push(`the question must keep the words of the search "${query}"`);
  const n = a.split(/\s+/).filter(Boolean).length;
  if (n < 30 || n > 80) out.push(`the answer must be 40-60 words (it is ${n})`);
  const source = [draft.h1, draft.direct_answer, ...(draft.sections || []).flatMap((s) => [s.heading, ...(s.paragraphs || []), ...(s.bullets || [])]), ...(draft.faq || []).flatMap((f) => [f.q, f.a]), ...(draft.facts || []).map((f) => f.claim)].join(' ');
  const lower = source.toLowerCase();
  for (const num of a.match(/\d[\d,.%$]*/g) || []) if (!source.includes(num.replace(/[.,]$/, ''))) out.push(`the number ${num} is not on the page`);
  for (const name of a.match(/(?<=[a-z,;:] )[A-Z][a-zA-Z]+/g) || []) if (!lower.includes(name.toLowerCase())) out.push(`the name ${name} is not on the page`);
  if (/https?:|www\./i.test(a)) out.push('no links in the answer');
  return out;
}

async function pageQueries(cfg, url, fetchImpl, now) {
  const site = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'];
  const r = await searchAnalytics(site, { startDate: dateDaysAgo(31, now), endDate: dateDaysAgo(3, now), dimensions: ['query'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: url }] }], rowLimit: 50 }, { fetchImpl });
  return r.ok ? { rows: r.rows.map((x) => ({ query: x.keys[0], impressions: x.impressions })) } : { notRead: r.reason };
}

async function draftEntry(cfg, chat, fetchImpl, draft, query) {
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({ cfg, fetchImpl, maxTokens: 600, messages: [
      { role: 'system', content: `You add one FAQ entry to a page for ${cfg.site_name}. Use ONLY facts the page states. No new numbers, prices, names, links, statistics, reviews, credentials or promises. Return ONLY JSON {"q":"...?","a":"40-60 words"}.` },
      { role: 'user', content: `Real search people typed: "${query}". Write the question in natural English, keeping the search's words, and answer it from this page only.${problems.length ? ` Your last draft was refused: ${problems.join('; ')}.` : ''}\n\nPAGE:\n${[draft.h1, draft.direct_answer, ...(draft.sections || []).flatMap((s) => [s.heading, ...(s.paragraphs || [])]), ...(draft.facts || []).map((f) => f.claim)].join('\n').slice(0, 6000)}` },
    ] });
    if (!r.ok) return { stop: r.reason };
    const e = parseJsonAnswer(r.answer);
    problems = e ? entryProblems(e, draft, query) : ['the reply was not the JSON asked for'];
    if (!problems.length) return { entry: { q: e.q.trim(), a: e.a.trim() } };
  }
  return { problems };
}

/**
 * Refreshes the due live pages in place. Returns { refreshed, checked, due }. `rules.strengthen` off
 * (mode slow/off) still fixes gone sources (a repair) but drafts no new question.
 */
export async function refreshPages(cfg, L, live, { today, now = new Date(), rules, chat, fetchImpl = fetch, index = [], notes = [] }) {
  const { due, take } = duePages(live, today);
  const res = { refreshed: 0, checked: 0, due: due.length };
  progress('check', `refresh: ${due.length} page(s) due, taking ${Math.min(take, due.length)}`);
  for (const p of due.slice(0, take)) {
    if (pastSoft()) { notes.push('REFRESH: the run time budget was used; the rest stay due'); break; }
    const draftFile = path.join(L.dir, 'drafts', `${p.slug}.json`);
    const file = path.join(cfg.root, p.rel);
    res.checked++;
    if (!fs.existsSync(draftFile) || !fs.existsSync(file)) { p.refreshed = { at: today, changes: [], left: 'no saved draft or page file' }; continue; }
    const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    const changes = []; const left = [];
    let next = { ...draft };
    const src = await recheckSources(draft.facts || [], fetchImpl);
    if (src.left) left.push(src.left);
    if (src.gone.length) { next.facts = src.facts; changes.push(...src.gone.map((f) => `gone source removed: ${f.source_url}`)); }
    if (rules?.strengthen && (next.faq || []).length < MAX_FAQ) {
      const g = await pageQueries(cfg, p.url, fetchImpl, now);
      if (g.notRead) left.push(`not read: Search Console queries (${g.notRead})`);
      else {
        const tried = new Set((p.refresh_tried || []).map(norm));
        const open = openQueries(next, g.rows).filter((r) => !tried.has(norm(r.query)));
        if (open.length) {
          const d = await draftEntry(cfg, chat, fetchImpl, next, open[0].query);
          if (d.entry) { next = { ...next, faq: [...(next.faq || []), d.entry] }; changes.push(`question added from a real search: "${open[0].query}"`); }
          else { p.refresh_tried = [...(p.refresh_tried || []), open[0].query].slice(-20); left.push(d.stop ? `no question drafted: ${d.stop}` : `draft for "${open[0].query}" refused: ${d.problems.join('; ')}`); }
        }
      }
    }
    if (!changes.length) { p.refreshed = { at: today, changes: [], ...(left.length ? { left } : {}) }; continue; }
    const before = fs.readFileSync(file, 'utf8');
    const relatedLinks = [...before.matchAll(/data-search-loop="related"[\s\S]*?<\/section>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)">([^<]+)</g)].map((x) => ({ route: x[1], anchor: x[2] })));
    const html = render(cfg, { slug: p.slug, draft: next, related: relatedLinks, published: p.published_at, modified: today });
    const was = new Set(gate({ query: p.query, html: before, facts: draft.facts || [] }, { cfg, corpus: index, selfRoute: p.route }));
    const problems = gate({ query: p.query, html, facts: next.facts || [] }, { cfg, corpus: index, selfRoute: p.route }).filter((x) => !was.has(x));
    if (problems.length) { p.refreshed = { at: today, changes: [], left: [...left, `the refreshed page failed the gate, left as it was: ${problems.slice(0, 2).join('; ')}`] }; continue; }
    const bh = sha256(before);
    fs.mkdirSync(path.dirname(L.snapshotPath(bh)), { recursive: true });
    fs.writeFileSync(L.snapshotPath(bh), before);
    fs.writeFileSync(file, html);
    fs.writeFileSync(draftFile, JSON.stringify(next, null, 2) + '\n');
    p.hash = sha256(html);
    p.modified_at = today;
    p.refreshed = { at: today, changes, before_hash: bh, after_hash: p.hash, ...(left.length ? { left } : {}) };
    res.refreshed++;
    notes.push(`REFRESH: ${p.route} — ${changes.join('; ')}`);
  }
  if (res.due && !res.refreshed) notes.push(`NAMED NOTE [REFRESH_NOTHING_CHANGED] ${res.due} page(s) due, ${res.checked} checked, 0 changed`);
  return res;
}

