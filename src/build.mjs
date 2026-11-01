// BUILD (daily): one page per easy search, published straight away once it
// passes the gate. Pace from pace.json, capped by the mode.
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from './ledger.mjs';
import { buildIndex } from './site-index.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { render, pageRel, pageUrl, withRelatedLink } from './render.mjs';
import { gate, LIMITS } from './gate.mjs';
import { centralDate, slugify, tokenOverlap, shingles, stripTags, sha256, fetchText, daysBetween } from './util.mjs';
import { intentKey as keyOf } from './find.mjs';
import { currentPace } from './pace.mjs';
import { isProtected } from './config.mjs';

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
  return [
    { role: 'system', content: `You write one web page that answers one search for ${cfg.site_name} (${cfg.base_url}). Audience: ${cfg.audience}. Voice: ${cfg.voice}. You return ONLY a JSON object, no prose around it.` },
    { role: 'user', content: `Search to answer: "${target.query}"
Existing pages on the site you may mention by title (do not invent others): ${related.map((r) => r.title).join(' | ') || 'none'}
The page ends by inviting the reader to: ${cfg.action.label}.${facts}

Return JSON with exactly these keys:
{
 "h1": "the search phrased as a clear question or title, 30-70 characters",
 "title_lead": "the search first, ${LIMITS.title[0] - cfg.site_name.length - 3 > 10 ? LIMITS.title[0] - cfg.site_name.length - 3 : 15}-${LIMITS.title[1] - cfg.site_name.length - 3} characters, no site name",
 "meta_description": "${LIMITS.meta[0]}-${LIMITS.meta[1]} characters, plain answer to the search",
 "direct_answer": "${LIMITS.answer[0]}-${LIMITS.answer[1]} words that answer the search outright and define it in the form '<subject> is ...'",
 "sections": [ {"heading": "a question people ask about this", "paragraphs": ["120-180 words", "..."]} ],  // 4-5 sections, 650+ words in total
 "faq": [ {"q": "a related question", "a": "${LIMITS.faqAnswer[0]}-${LIMITS.faqAnswer[1]} words"} ],  // exactly 4
 "facts": [ {"claim": "one checkable fact in one sentence", "source_url": "https URL of a well-known public page that states it (government, university, major publication, Wikipedia)", "source_name": "publisher name"} ]  // 2-4
}
If this search does not fit the audience or the site (a different meaning of the words, someone else's brand), return {"skip":"why"} instead.
Hard rules: no statistics, percentages or "studies show" anywhere except inside "facts"; no named people, quotes, doctors, credentials, reviews, testimonials or star ratings; no promises of outcomes${cfg.health_gate !== 'none' ? '; no treatment or outcome claims, never "painless", no medical advice, no hours or services beyond the real facts' : ''}; no filler; second person, short sentences.${problems ? `\n\nYour previous draft failed these checks; fix every one:\n- ${problems.join('\n- ')}` : ''}` },
  ];
}

// A meta description over 160 characters is cut at a word boundary (never padded).
export function fitMeta(m) {
  const s = String(m || '').trim();
  if (s.length <= LIMITS.meta[1]) return s;
  const cut = s.slice(0, LIMITS.meta[1] - 1).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '');
  return cut.length >= LIMITS.meta[0] ? cut + '.' : s;
}

export function cleanDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  const out = {
    h1: str(d.h1), title_lead: str(d.title_lead), meta_description: str(d.meta_description), direct_answer: str(d.direct_answer),
    sections: (Array.isArray(d.sections) ? d.sections : []).map((s) => ({ heading: str(s?.heading), paragraphs: (Array.isArray(s?.paragraphs) ? s.paragraphs : []).map(str).filter(Boolean) })).filter((s) => s.heading && s.paragraphs.length),
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

export async function build(cfg, { mode, rules, now = new Date(), fetchImpl = fetch, chat = freeChat, notes = [] } = {}) {
  const L = ledger(cfg);
  const today = centralDate(now);
  const result = { published: 0, dropped: 0, attempted: 0, related_links: 0, quota: 0, mode };
  if (!rules.build) { notes.push('BUILD skipped: mode=off'); return result; }
  const book = L.pages();
  book.pages ||= []; book.dropped ||= [];
  const pace = currentPace(cfg, L);
  const publishedToday = book.pages.filter((p) => p.published_at === today).length;
  let cap = rules.build_cap == null ? pace.per_day : Math.min(pace.per_day, rules.build_cap);
  result.quota = Math.max(0, cap - publishedToday);
  if (!result.quota) { notes.push(`BUILD: today's quota (${cap}) already published`); return result; }
  const targets = (L.read('targets', { targets: [] }).targets || []).filter((t) => t.kind === 'new');
  if (!targets.length) { notes.push('NAMED STOP [NO_TARGETS] FIND has produced no new searches to build; the next weekly FIND refills the list'); return result; }
  const taken = new Set(book.pages.map((p) => keyOf(p.query)));
  const recentlyDropped = new Set(book.dropped.filter((d) => daysBetween(d.at, today) < DROP_RETRY_DAYS).map((d) => keyOf(d.query)));
  const queue = targets.filter((t) => !taken.has(keyOf(t.query)) && !recentlyDropped.has(keyOf(t.query)));
  const index = buildIndex(cfg, { withText: true });
  const menu = menuRoutes(cfg);
  const siblings = [];
  let failsInRow = 0;
  for (const target of queue) {
    if (result.published >= result.quota || result.attempted >= result.quota * 2 + 2) break;
    result.attempted++;
    const slug = slugify(target.query);
    const rel = pageRel(cfg, slug);
    const route = cfg.output.url_prefix + slug + (cfg.output.format === 'dir-index' ? '/' : '');
    if (fs.existsSync(path.join(cfg.root, rel)) || isProtected(cfg, rel)) { book.dropped.push({ query: target.query, at: today, reason: 'path exists or is protected' }); result.dropped++; continue; }
    const related = pickRelated(cfg, index, target.query, { n: 3 });
    let problems = null; let html = null; let draft = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await chat({ cfg, messages: draftPrompt(cfg, target, related, problems), fetchImpl });
      if (!r.ok) {
        if (r.stop === 'FREE_MODEL_KEY_MISSING' || r.stop === 'FREE_MODEL_KEY_REFUSED') { notes.push(`NAMED STOP [${r.stop}] ${r.reason}; BUILD wrote nothing, CHECK and the report still run`); result.stopped = r.stop; return finish(); }
        failsInRow++;
        if (r.rateLimited || r.stop === 'NO_FREE_MODEL') {
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
      problems = gate({ query: target.query, html, facts: draft.facts }, { cfg, corpus: index, siblings, selfRoute: route });
      if (!problems.length) break;
    }
    if (!html && !problems) { result.model_failed = (result.model_failed || 0) + 1; continue; } // model never answered: retry next run, not a drop
    if (!html || problems?.length) {
      book.dropped.push({ query: target.query, at: today, reason: (problems || ['no draft from the free model']).slice(0, 5) });
      result.dropped++;
      continue;
    }
    const full = path.join(cfg.root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html);
    siblings.push({ route, sh: shingles(stripTags(html)) });
    fs.mkdirSync(path.join(L.dir, 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(L.dir, 'drafts', `${slug}.json`), JSON.stringify(draft, null, 2) + '\n');
    // Never an orphan: link the new page from up to N relevant existing pages.
    const linkedFrom = [];
    const hosts = pickRelated(cfg, index, target.query, { n: cfg.related.max_pages_per_new_page, editable: true, menu });
    for (const h of hosts) {
      const file = path.join(cfg.root, h.rel);
      const before = fs.readFileSync(file, 'utf8');
      const after = withRelatedLink(before, { route, anchor: draft.h1 });
      if (!after || after === before) continue;
      fs.writeFileSync(file, after);
      linkedFrom.push({ rel: h.rel, route: h.route, before_hash: sha256(before), after_hash: sha256(after) });
    }
    result.related_links += linkedFrom.length;
    book.pages.push({ slug, query: target.query, score: target.score, signals: target.signals, rel, route, url: pageUrl(cfg, slug), published_at: today, status: 'live', hash: sha256(html), model: 'free-route', facts: draft.facts.filter((f) => f.verified).map((f) => f.source_url), linked_from: linkedFrom, checks: {} });
    result.published++;
  }
  return finish();
  function finish() {
    L.write('pages', book);
    if (!result.published && !result.stopped) notes.push(`BUILD published 0 of quota ${result.quota}: ${result.dropped} draft(s) failed the gate and were dropped; ${result.model_failed || 0} got no answer from the free model and stay queued`);
    return result;
  }
}
