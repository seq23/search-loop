// BUILD (daily): one page per easy, DISTINCT search, published straight away
// once it passes the gate, only while the site is under its outcome-gated cap
// (cap.mjs). A search with the same intent as an existing page becomes a
// "strengthen <URL>" brief instead (distinct.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from './ledger.mjs';
import { buildIndex } from './site-index.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { render, pageRel, pageUrl, withRelatedLink, fitMeta } from './render.mjs';
import { gateReport, LIMITS } from './gate.mjs';
import { centralDate, slugify, tokenOverlap, shingles, stripTags, sha256, fetchText, daysBetween, pastSoft, progress } from './util.mjs';
import { intentKey as keyOf } from './find.mjs';
import { currentCap, liveEnginePages, recordHeld, CAP_DEFAULTS } from './cap.mjs';
import { corpusFor, matchIntent, matchAnswer, engineAnswers, intentWords, siteWordsOf, answerShingles } from './distinct.mjs';
import { isProtected, publishedFrozen, approvalOf } from './config.mjs';

export const DROP_RETRY_DAYS = 28;
export const MAX_ATTEMPTS = 3; // one draft + two fix passes, then drop

export function menuRoutes(cfg) {
  if (Array.isArray(cfg.menu_pages)) return new Set(cfg.menu_pages);
  const home = path.join(cfg.root, 'index.html');
  if (!fs.existsSync(home)) return new Set();
  const html = fs.readFileSync(home, 'utf8');
  const out = new Set();
  for (const nav of html.match(/<nav[\s\S]*?<\/nav>/gi) || []) for (const m of nav.matchAll(/href=["'](\/[^"'#?]*)/g)) out.add(m[1]);
  return out;
}

export function pickRelated(cfg, index, query, { exclude = new Set(), n = 3, editable = false, menu = new Set() } = {}) {
  return index
    .filter((p) => !exclude.has(p.route) && p.title && !(editable && (p.protected || (cfg.menu_pages_need_approval && menu.has(p.route)) || (p.canonical && !p.canonical.startsWith(cfg.base_url)))))
    .map((p) => ({ p, s: Math.max(tokenOverlap(p.h1 || p.title, query), tokenOverlap(p.title, query) * 0.9) }))
    .filter((x) => x.s >= 0.34)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.p);
}

export function draftPrompt(cfg, target, related, problems) {
  const facts = cfg.health?.real_facts ? `\nReal facts on record (use only these for services/hours): ${JSON.stringify(cfg.health.real_facts)}` : '';
  // v1.5.0: a search that names one of the site's places gets real local substance, never a city-name swap.
  const places = cfg.local ? [cfg.local.city, ...(cfg.local.neighbourhoods || [])].filter(Boolean) : [];
  const place = places.find((pl) => String(target.query).toLowerCase().includes(String(pl).toLowerCase()));
  const local = place && cfg.local?.substance ? `\nThis is a local page for ${place}. ${cfg.local.substance}` : '';
  return [
    { role: 'system', content: `You write one web page that answers one search for ${cfg.site_name} (${cfg.base_url}). Audience: ${cfg.audience}. Voice: ${cfg.voice}. You return ONLY a JSON object, no prose around it.` },
    { role: 'user', content: `Search to answer: "${target.query}"
Existing pages on the site you may mention by title (do not invent others): ${related.map((r) => r.title).join(' | ') || 'none'}
The page ends by inviting the reader to: ${cfg.action.label}.${facts}${local}

Return JSON with exactly these keys:
{
 "h1": "the search phrased as a clear question or title, 30-70 characters",
 "title_lead": "the search first, ${LIMITS.title[0] - cfg.site_name.length - 3 > 10 ? LIMITS.title[0] - cfg.site_name.length - 3 : 15}-${LIMITS.title[1] - cfg.site_name.length - 3} characters, no site name",
 "meta_description": "${LIMITS.meta[0]}-${LIMITS.meta[1]} characters, plain answer to the search",
 "direct_answer": "${LIMITS.answer[0]}-${LIMITS.answer[1]} words that answer the search outright and define it in the form '<subject> is ...'",
 "sections": [ {"heading": "a question people ask about this", "paragraphs": ["120-180 words", "..."], "bullets": ["optional: 3-6 short list items"]} ],  // 4-5 sections, 650+ words in total; at least one section has "bullets"
 "faq": [ {"q": "a related question", "a": "${LIMITS.faqAnswer[0]}-${LIMITS.faqAnswer[1]} words"} ],  // exactly 4
 "facts": [ {"claim": "one checkable fact in one sentence", "source_url": "https URL of a well-known public page that states it (government, university, major publication, Wikipedia)", "source_name": "publisher name"} ]  // 2-4, from at least 2 different sources
}
If this search does not fit the audience or the site (a different meaning of the words, someone else's brand), return {"skip":"why"} instead.
Hard rules: no statistics, percentages or "studies show" anywhere except inside "facts"; no named people, quotes, doctors, credentials, reviews, testimonials or star ratings; no promises of outcomes${cfg.health_gate !== 'none' ? '; no treatment or outcome claims, never "painless", no medical advice, no hours or services beyond the real facts' : ''}; no filler; second person, short sentences.${problems ? `\n\nYour previous draft failed these checks; fix every one:\n- ${problems.join('\n- ')}` : ''}` },
  ];
}

// Lengths are fitted where the page is written (render.mjs); kept exported here for callers.
export { fitMeta };

export function cleanDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  const out = {
    h1: str(d.h1), title_lead: str(d.title_lead), meta_description: str(d.meta_description), direct_answer: str(d.direct_answer),
    sections: (Array.isArray(d.sections) ? d.sections : []).map((s) => ({ heading: str(s?.heading), paragraphs: (Array.isArray(s?.paragraphs) ? s.paragraphs : []).map(str).filter(Boolean), bullets: (Array.isArray(s?.bullets) ? s.bullets : []).map(str).filter(Boolean).slice(0, 8) })).filter((s) => s.heading && s.paragraphs.length),
    faq: (Array.isArray(d.faq) ? d.faq : []).map((f) => ({ q: str(f?.q), a: str(f?.a) })).filter((f) => f.q && f.a).slice(0, 6),
    facts: (Array.isArray(d.facts) ? d.facts : []).map((f) => ({ claim: str(f?.claim), source_url: str(f?.source_url), source_name: str(f?.source_name) })).filter((f) => f.claim && /^https:\/\//.test(f.source_url)).slice(0, 4),
  };
  return out.h1 && out.direct_answer && out.sections.length && out.faq.length ? out : null;
}

export async function verifyFacts(facts, fetchImpl = fetch) {
  for (const f of facts) {
    if (f.verified !== undefined) continue;
    const r = await fetchText(f.source_url, { fetchImpl, timeoutMs: 10000, headers: { 'user-agent': 'Mozilla/5.0 (compatible; search-loop source check; +https://github.com/seq23/search-loop)' } });
    f.verified = r.status >= 200 && r.status < 400 && r.text.length > 500;
    f.checked_status = r.status;
  }
  return facts;
}

// Today's per-run guard after the mode (normal: cap.max_per_day 10; slow: 3; off: 0).
export function perDayLimit(cfg, rules) {
  if (!rules.build) return 0;
  const perDay = { ...CAP_DEFAULTS, ...(cfg.cap || {}) }.max_per_day;
  return rules.build_cap == null ? perDay : Math.min(perDay, rules.build_cap);
}

// Same intent as an existing page: no new page. The brief goes on the existing
// strengthen path (targets.json "strengthen", and the engine page's own
// strengthen queries) and into pages.json "redirected" for the week report.
export function redirectToStrengthen(L, book, target, match, { today, stage, frozen = false }) {
  if (frozen) {
    // Published pages frozen on this site: the search is simply skipped; no brief touches the existing page.
    const rec = { query: target.query, at: today, reason: [`same intent as ${match.url} (${match.by}); skipped, published pages are frozen on this site`] };
    book.dropped.push(rec);
    return rec;
  }
  const rec = { query: target.query, at: today, url: match.url, route: match.route, kind: match.kind, matched_by: match.by, matched_text: match.matched_text, stage };
  book.redirected ||= [];
  book.redirected.push(rec);
  book.redirected = book.redirected.slice(-500);
  const eng = book.pages.find((p) => p.route === match.route && p.status === 'live');
  if (eng) eng.extra_queries = [...new Set([...(eng.extra_queries || []), target.query])].slice(-10);
  const t = L.read('targets', null);
  if (t) {
    t.strengthen ||= [];
    if (!t.strengthen.some((x) => x.query === target.query && x.page === match.route)) t.strengthen.unshift({ query: target.query, page: match.route, url: match.url, score: target.score, from: 'distinct-gate', matched_by: match.by, at: today });
    t.strengthen = t.strengthen.slice(0, 100);
    L.write('targets', t);
  }
  return rec;
}

// Approval mode: pages the owners approved go live (copied from the queue to
// their real route); declined pages leave the queue for good. Nothing else
// ever moves a queued page into the site.
export function promoteApproved(cfg, appr, L, book, today, result, notes) {
  const file = path.join(cfg.root, appr.approvals_file);
  let list = {};
  if (fs.existsSync(file)) {
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { notes.push(`NAMED NOTE [APPROVALS_UNREADABLE] ${appr.approvals_file} is not valid JSON (${e.message}); no queued page went live this run`); return; }
  }
  const ids = (xs) => new Set((Array.isArray(xs) ? xs : []).map((x) => (typeof x === 'string' ? x : x?.slug)).filter(Boolean));
  const ok = ids(list.approved); const no = ids(list.declined);
  let went = 0; let declined = 0;
  const drop = (src) => { if (cfg.output.format === 'dir-index') fs.rmSync(path.dirname(src), { recursive: true, force: true }); else fs.rmSync(src, { force: true }); };
  for (const p of book.pages) {
    if (p.status !== 'pending_approval') continue;
    const src = path.join(cfg.root, appr.pending_dir, p.rel);
    if (no.has(p.slug)) { drop(src); p.status = 'declined'; p.declined_at = today; declined++; continue; }
    if (!ok.has(p.slug)) continue;
    const dest = path.join(cfg.root, p.rel);
    if (!fs.existsSync(src)) { notes.push(`NAMED NOTE [APPROVED_PAGE_MISSING] "${p.slug}" is approved but ${appr.pending_dir}/${p.rel} is gone; it stays off the site`); continue; }
    if (fs.existsSync(dest) || isProtected(cfg, p.rel)) { notes.push(`NAMED NOTE [APPROVED_PATH_TAKEN] "${p.slug}" is approved but ${p.rel} already exists or is protected; it stays in the queue`); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    drop(src);
    p.status = 'live'; p.published_at = today; p.approved_at = today;
    result.published++; went++;
  }
  if (went || declined) { L.write('pages', book); notes.push(`BUILD approval: ${went} approved page(s) went live, ${declined} declined page(s) left the queue`); }
}

export async function build(cfg, { mode, rules, now = new Date(), fetchImpl = fetch, chat = freeChat, notes = [] } = {}) {
  const L = ledger(cfg);
  const today = centralDate(now);
  const result = { published: 0, dropped: 0, attempted: 0, related_links: 0, quota: 0, redirected: 0, held: 0, mode };
  if (!rules.build) { notes.push('BUILD skipped: mode=off'); return result; }
  const book = L.pages();
  book.pages ||= []; book.dropped ||= []; book.redirected ||= [];
  const appr = approvalOf(cfg);
  if (appr) { result.queued = 0; promoteApproved(cfg, appr, L, book, today, result, notes); }
  const made = () => result.published + (result.queued || 0);
  // Approval mode: the day's limit counts pages written to the queue, not approvals.
  const publishedToday = book.pages.filter((p) => (appr ? p.queued_at === today : p.published_at === today)).length;
  const perDay = perDayLimit(cfg, rules);
  const dayLeft = Math.max(0, perDay - publishedToday);
  let capState = currentCap(cfg, L, book);
  const live = liveEnginePages(book).length;
  const room = Math.max(0, capState.max_live_pages - live);
  result.cap = { max_live_pages: capState.max_live_pages, live, room };
  result.quota = Math.min(dayLeft, room);
  if (!dayLeft) { notes.push(`BUILD: today's limit (${perDay}) already published`); return result; }
  const targets = (L.read('targets', { targets: [] }).targets || []).filter((t) => t.kind === 'new');
  if (!targets.length) { notes.push('NAMED STOP [NO_TARGETS] FIND has produced no new searches to build; the next weekly FIND refills the list'); return result; }
  const taken = new Set(book.pages.map((p) => keyOf(p.query)));
  const recentlyDropped = new Set([...book.dropped, ...book.redirected].filter((d) => daysBetween(d.at, today) < DROP_RETRY_DAYS).map((d) => keyOf(d.query)));
  const queue = targets.filter((t) => !taken.has(keyOf(t.query)) && !recentlyDropped.has(keyOf(t.query)));
  const index = buildIndex(cfg, { withText: true });
  const corpus = corpusFor(cfg, index, book);
  const answers = engineAnswers(cfg, L, book);
  const sw = siteWordsOf(cfg);
  const menu = menuRoutes(cfg);
  const frozen = publishedFrozen(cfg);
  const siblings = [];
  let failsInRow = 0;
  let heldStop = false;
  let considered = 0;
  for (const target of queue) {
    if (made() >= room) { heldStop = true; break; }
    if (made() >= result.quota || result.attempted >= result.quota * 2 + 2 || considered >= result.quota * 6 + 10) break;
    considered++;
    // Distinct intent gate, before any model call: same intent as an existing page -> strengthen brief.
    const pre = matchIntent(cfg, target.query, corpus);
    if (pre) { redirectToStrengthen(L, book, target, pre, { today, stage: 'search', frozen }); if (frozen) result.skipped_same_intent = (result.skipped_same_intent || 0) + 1; else result.redirected++; continue; }
    if (pastSoft()) { notes.push(`NAMED NOTE [RUN_TIME_BUDGET] BUILD stopped at the run's time budget after ${result.attempted} search(es); the rest stay queued for the next run`); break; }
    result.attempted++;
    progress('build', `page ${result.attempted} (quota ${result.quota}): "${target.query}"`);
    const slug = slugify(target.query);
    const rel = pageRel(cfg, slug);
    const route = cfg.output.url_prefix + slug + (cfg.output.format === 'dir-index' ? '/' : '');
    if (fs.existsSync(path.join(cfg.root, rel)) || (appr && fs.existsSync(path.join(cfg.root, appr.pending_dir, rel))) || isProtected(cfg, rel)) { book.dropped.push({ query: target.query, at: today, reason: 'path exists or is protected' }); result.dropped++; continue; }
    const related = pickRelated(cfg, index, target.query, { n: 3 });
    let problems = null; let html = null; let draft = null; let gateNotes = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await chat({ cfg, messages: draftPrompt(cfg, target, related, problems), fetchImpl });
      if (!r.ok) {
        if (r.stop === 'MODEL_TIME_BUDGET') { result.model_failed = (result.model_failed || 0) + 1; notes.push(`NAMED NOTE [RUN_TIME_BUDGET] ${r.reason}`); return finish(); }
        if (r.stop === 'FREE_MODEL_KEY_MISSING' || r.stop === 'FREE_MODEL_KEY_REFUSED') { notes.push(`NAMED STOP [${r.stop}] ${r.reason}; BUILD wrote nothing, CHECK and the report still run`); result.stopped = r.stop; return finish(); }
        failsInRow++;
        if (r.rateLimited || r.stop === 'NO_FREE_MODEL') {
          result.lanes_out = String(r.reason).slice(0, 400);
          if (result.mode !== 'slow') {
            result.mode = 'slow';
            notes.push(`NAMED NOTE [FREE_MODEL_RATE_LIMITED] the free model route is rate-limited or exhausted (${r.reason}); this run dropped itself to slow for today`);
            result.quota = Math.min(result.quota, Math.max(0, 3 - publishedToday));
          }
        }
        if (failsInRow >= 2) { notes.push('BUILD stopped early: the free model route failed twice in a row'); return finish(); }
        break;
      }
      failsInRow = 0;
      const parsed = parseJsonAnswer(r.answer);
      if (parsed?.skip) { problems = [`off-audience: ${String(parsed.skip).slice(0, 120)}`]; html = null; break; }
      draft = cleanDraft(parsed);
      if (!draft) { problems = ['the answer was not the JSON object asked for, with every key filled']; continue; }
      draft.meta_description = fitMeta(draft.meta_description);
      draft.facts = await verifyFacts(draft.facts, fetchImpl);
      html = render(cfg, { slug, draft, related: related.map((p) => ({ route: p.route, anchor: p.h1 || p.title })), published: today });
      // Distinct intent gate, after drafting: the H1 the model chose, and the answer it gave.
      const post = matchIntent(cfg, draft.h1, corpus) || matchAnswer(cfg, draft.direct_answer, answers);
      if (post) { draft = null; html = null; problems = null; target.__redirect = post; break; }
      ({ problems, notes: gateNotes } = gateReport({ query: target.query, html, facts: draft.facts }, { cfg, corpus: index, siblings, selfRoute: route }));
      if (!problems.length) break;
    }
    if (target.__redirect) { const m = target.__redirect; delete target.__redirect; redirectToStrengthen(L, book, target, m, { today, stage: 'draft', frozen }); if (frozen) result.skipped_same_intent = (result.skipped_same_intent || 0) + 1; else result.redirected++; continue; }
    if (!html && !problems) { result.model_failed = (result.model_failed || 0) + 1; continue; } // model never answered: retry next run, not a drop
    if (!html || problems?.length) {
      book.dropped.push({ query: target.query, at: today, reason: (problems || ['no draft from the free model']).slice(0, 5) });
      result.dropped++;
      continue;
    }
    // Approval mode: the page goes into the owners' queue, never into the site.
    const full = appr ? path.join(cfg.root, appr.pending_dir, rel) : path.join(cfg.root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html);
    siblings.push({ route, sh: shingles(stripTags(html)) });
    // Later searches this run are compared with this page too.
    corpus.push({ route, url: pageUrl(cfg, slug), kind: 'engine', slug, sets: [target.query, draft.h1].map((t) => ({ text: t, words: intentWords(t, sw) })).filter((x) => x.words.size) });
    answers.push({ route, url: pageUrl(cfg, slug), text: draft.direct_answer, sh: answerShingles(draft.direct_answer) });
    fs.mkdirSync(path.join(L.dir, 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(L.dir, 'drafts', `${slug}.json`), JSON.stringify(draft, null, 2) + '\n');
    // Never an orphan: link the new page from up to N relevant existing pages
    // (not on a site whose published pages are frozen: those are never edited).
    const linkedFrom = [];
    const hosts = frozen || appr ? [] : pickRelated(cfg, index, target.query, { n: cfg.related.max_pages_per_new_page, editable: true, menu });
    for (const h of hosts) {
      const file = path.join(cfg.root, h.rel);
      const before = fs.readFileSync(file, 'utf8');
      const after = withRelatedLink(before, { route, anchor: draft.h1 });
      if (!after || after === before) continue;
      fs.writeFileSync(file, after);
      linkedFrom.push({ rel: h.rel, route: h.route, before_hash: sha256(before), after_hash: sha256(after) });
    }
    result.related_links += linkedFrom.length;
    if (appr) {
      book.pages.push({ slug, query: target.query, score: target.score, signals: target.signals, rel, route, url: pageUrl(cfg, slug), published_at: null, queued_at: today, status: 'pending_approval', pending_rel: path.posix.join(appr.pending_dir, rel), hash: sha256(html), model: 'free-route', facts: draft.facts.filter((f) => f.verified).map((f) => f.source_url), linked_from: [], checks: {}, ...(gateNotes.length ? { gate_notes: gateNotes } : {}) });
      result.queued++;
      continue;
    }
    book.pages.push({ slug, query: target.query, score: target.score, signals: target.signals, rel, route, url: pageUrl(cfg, slug), published_at: today, status: 'live', hash: sha256(html), model: 'free-route', facts: draft.facts.filter((f) => f.verified).map((f) => f.source_url), linked_from: linkedFrom, checks: {}, ...(gateNotes.length ? { gate_notes: gateNotes } : {}) });
    result.published++;
    if (gateNotes.length) result.noted = (result.noted || 0) + 1;
  }
  if (!heldStop && room < dayLeft && made() >= room && queue.length > considered) heldStop = true;
  return finish();
  function finish() {
    if (heldStop || room === 0) {
      result.held = Math.max(0, Math.min(dayLeft - result.published, queue.length - considered));
      if (result.held) { capState = recordHeld(capState, result.held, now); L.write('cap', capState); }
      notes.push(`BUILD held by the cap: ${live + result.published} live engine page(s), cap ${capState.max_live_pages} (${capState.reason}); ${result.held} more page(s) today would have gone over it, those searches stay queued`);
    }
    if (result.skipped_same_intent) notes.push(`BUILD distinct gate: ${result.skipped_same_intent} search(es) had the same intent as an existing page and were skipped (published pages are frozen on this site, so no strengthen brief)`);
    if (frozen && result.published) notes.push(`BUILD: published pages are frozen on this site, so no existing page was edited to link the ${result.published} new page(s); link them from the site's own build or nav`);
    if (appr && result.queued) notes.push(`BUILD approval mode: ${result.queued} new page(s) written to the owners' queue (${appr.pending_dir}); none goes live until its slug is approved in ${appr.approvals_file}`);
    if (result.redirected) notes.push(`BUILD distinct gate: ${result.redirected} search(es) had the same intent as an existing page and became strengthen briefs, not new pages (pages.json "redirected")`);
    L.write('pages', book);
    if (result.noted) notes.push(`BUILD gate notes (not blocking): ${result.noted} published page(s) are outside a length or style aim; each is listed under gate_notes in pages.json`);
    if (!made() && !result.stopped && result.quota) notes.push(`BUILD published 0 of quota ${result.quota}: ${result.dropped} draft(s) failed the gate and were dropped; ${result.model_failed || 0} got no answer from the free model and stay queued`);
    return result;
  }
}
