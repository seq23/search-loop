// CHECK + REPAIR: every page at 2/4/8 weeks (and 90 days). Winners seed more
// pages on their topic; pages near page 1 are strengthened with a before/after
// hash and an automatic undo if they get worse; 90 days with no impressions ->
// merged into a stronger page with a 301.
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from './ledger.mjs';
import { searchAnalytics, inspectUrl, dateDaysAgo } from './gsc.mjs';
import { cloudflareDay } from './analytics.mjs';
import { centralDate, isoWeek, daysBetween, sha256, fetchText, tokenOverlap, pastSoft, progress, norm } from './util.mjs';
import { render, withoutRelatedLink, relatedLinksOf, draftDrift, EDITED_PAGE, actionLine } from './render.mjs';
import { gate } from './gate.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { buildIndex } from './site-index.mjs';
import { verifyFacts, capRepeats, shapeGaps, defineLead } from './build.mjs';
import { publishedFrozen } from './config.mjs';
import { learnWeights } from './compete.mjs';
import { refreshPages } from './refresh.mjs';
import { aiLedger, actionFor, recordAction, saveAiLedger, samePage, ID_RE } from './ai-misses.mjs';

export const CHECKPOINTS = [['w2', 14], ['w4', 28], ['w8', 56], ['d90', 90]];
export const NEAR_PAGE_ONE = [10.5, 20];
export const UNDO_IF_WORSE_BY = 2;
export const STRENGTHEN_SETTLE_DAYS = 14;
export const INDEX_WINDOW_DAYS = 14;
export const AI_MISS_PAGES_PER_RUN = 3;
// An AI-miss strengthen waits for a newer Boss OS read to settle; with none in 28 days it is
// settled as not read, so the page is never stuck mid-strengthen (refresh comes at 30 days).
export const AI_MISS_SETTLE_MAX_DAYS = 28;

// Search Console strengthens a page once ever; an AI-miss strengthen does not use that up.
const gscStrengthened = (page) => [page.strengthen, ...(page.strengthen_history || [])].some((s) => s && s.trigger !== 'ai_miss');

export function dueCheckpoints(page, today) {
  const age = daysBetween(page.published_at, today);
  return CHECKPOINTS.filter(([k, d]) => age >= d && !page.checks?.[k]).map(([k]) => k);
}

// One decision per checkpoint. Pure; tests pin it.
export function decide(page, snap, { rules, today }) {
  const out = [];
  if (snap.clicks > 0 || (snap.position && snap.position <= 10)) out.push('winner');
  const s = page.strengthen;
  if (s && !s.verdict && daysBetween(s.at, today) >= STRENGTHEN_SETTLE_DAYS && snap.position != null && s.baseline_position != null) {
    const worse = snap.position > s.baseline_position + UNDO_IF_WORSE_BY;
    // An AI-miss strengthen is kept by the next AI read (settleAiMisses); Search Console can only undo it.
    if (worse) out.push(rules.undo ? 'undo' : 'hold');
    else if (s.trigger !== 'ai_miss') out.push('keep');
  }
  if (!(s && !s.verdict) && !gscStrengthened(page) && rules.strengthen && snap.position != null && snap.position >= NEAR_PAGE_ONE[0] && snap.position <= NEAR_PAGE_ONE[1] && ['w4', 'w8'].includes(snap.checkpoint)) out.push('strengthen');
  if (snap.checkpoint === 'd90' && snap.impressions === 0 && snap.source === 'search_console' && rules.merge) out.push('merge');
  return out;
}

export async function submitIndexNow(cfg, urls, { fetchImpl = fetch } = {}) {
  const key = cfg.indexnow?.key || process.env.INDEXNOW_KEY;
  if (!key) return { notRead: 'no IndexNow key (config indexnow.key or INDEXNOW_KEY)' };
  if (!urls.length) return { submitted: 0 };
  const body = JSON.stringify({ host: new URL(cfg.base_url).host, key, keyLocation: cfg.indexnow?.key_location || `${cfg.base_url}/${key}.txt`, urlList: urls });
  const out = {};
  for (const ep of ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow']) {
    const r = await fetchText(ep, { method: 'POST', body, headers: { 'content-type': 'application/json; charset=utf-8' }, fetchImpl });
    out[new URL(ep).host] = r.status;
  }
  const ok = Object.values(out).some((s) => s === 200 || s === 202);
  return ok ? { submitted: urls.length, status: out } : { notRead: `IndexNow refused (${JSON.stringify(out)})`, status: out };
}

async function gscPages(cfg, now, fetchImpl) {
  const site = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'];
  const r = await searchAnalytics(site, { startDate: dateDaysAgo(31, now), endDate: dateDaysAgo(3, now), dimensions: ['page'], rowLimit: 25000 }, { fetchImpl });
  if (!r.ok) return { notRead: r.reason, site };
  const map = new Map();
  for (const row of r.rows) map.set(row.keys[0], { clicks: row.clicks, impressions: row.impressions, position: Math.round(row.position * 10) / 10 });
  return { map, site };
}

export async function check(cfg, { rules: modeRules, mode, now = new Date(), fetchImpl = fetch, chat = freeChat, notes = [], ai = null } = {}) {
  const L = ledger(cfg);
  const today = centralDate(now);
  // Published pages frozen (Horse, Hicks): checkpoints are still measured and
  // recorded, but nothing already published is strengthened, undone or merged.
  const frozen = publishedFrozen(cfg);
  const rules = frozen ? { ...modeRules, strengthen: false, undo: false, merge: false } : modeRules;
  if (frozen) notes.push('CHECK: published pages are frozen on this site; checkpoints are recorded, no page is strengthened, undone or merged');
  const runs = L.read('runs', { last_check: null, history: [] });
  const res = { checked: 0, wins: 0, strengthened: 0, undone: 0, merged: 0, indexnow: 0, indexed: null, ai: null };
  if (rules.check === 'weekly' && runs.last_check && daysBetween(runs.last_check, today) < 6) {
    notes.push(`CHECK runs weekly in mode=${mode}; last ran ${runs.last_check}`);
    res.skipped = true;
  }
  const book = L.pages();
  book.pages ||= [];
  const live = book.pages.filter((p) => p.status === 'live');

  // AI visitors + bot hits, accumulated daily (Cloudflare keeps short windows on free zones).
  const daily = L.read('ai_daily', { schema: 'search-loop-ai-daily-v1', days: {} });
  // A day not fully read is read again on the next run (v1.5.1), so a fixed credential shows numbers the same day.
  const partial = (d) => !d || d.not_read || d.ai_visitors_not_read || d.ai_bot_hits_not_read;
  if (partial(daily.days[today])) {
    if (cfg.analytics?.ai_referrals === 'cloudflare' || cfg.analytics?.ai_bot_hits === 'cloudflare') {
      const r = await cloudflareDay({ zoneName: cfg.analytics.zone || new URL(cfg.base_url).host, fetchImpl, now });
      daily.days[today] = r.notRead ? { not_read: r.notRead } : {
        ...(r.ai_visitors ? { ai_visitors: r.ai_visitors } : { ai_visitors_not_read: r.visitorsNotRead }),
        ...(r.ai_bot_hits ? { ai_bot_hits: r.ai_bot_hits } : { ai_bot_hits_not_read: r.botsNotRead }),
      };
    } else daily.days[today] = { not_read: 'no free analytics source configured for this site (analytics.ai_referrals)' };
    const keep = Object.keys(daily.days).sort().slice(-120);
    daily.days = Object.fromEntries(keep.map((k) => [k, daily.days[k]]));
    L.write('ai_daily', daily);
  }

  // IndexNow: every new page once it answers 200 live.
  const pending = live.filter((p) => !p.indexnow_at);
  const liveUrls = [];
  progress('check', `IndexNow: ${pending.length} page(s) not yet submitted`);
  for (const p of pending.slice(0, 100)) { if (pastSoft()) break; const r = await fetchText(p.url, { fetchImpl, timeoutMs: 10000, retries: 0 }); if (r.status === 200) liveUrls.push(p.url); }
  if (liveUrls.length) {
    const r = await submitIndexNow(cfg, liveUrls, { fetchImpl });
    if (r.notRead) notes.push(`NAMED NOTE [INDEXNOW_NOT_SENT] ${r.notRead}`);
    else { for (const p of pending) if (liveUrls.includes(p.url)) p.indexnow_at = today; res.indexnow = r.submitted; }
  } else if (pending.length) notes.push(`IndexNow: ${pending.length} new page(s) not live yet; submitted when they answer 200`);

  if (res.skipped) {
    if (ai?.ok) for (const m of ai.misses) if (m.page_url) ai.skipped.push({ id: m.id, reason: `CHECK runs weekly in mode=${mode} and did not run today` });
    L.write('pages', book); return res;
  }

  progress('check', `Search Console rows for ${live.length} live page(s)`);
  const g = live.length ? await gscPages(cfg, now, fetchImpl) : { map: new Map() };
  if (g.notRead) notes.push(`not read: Search Console page data (${g.notRead})`);
  // Pages measured against Search Console this run, checkpoint due or not. A CHECK
  // run that read every live page and found none due did its job (local-guides:
  // 13 live pages, first checkpoints at 2 weeks); it is not NOTHING_DONE.
  res.measured = g.notRead ? 0 : live.length;

  // Index status (pages 14-42 days old) for the report, URL Inspection, free.
  let measured = 0; let indexed = 0; let inspectFail = null;
  for (const p of live) {
    const age = daysBetween(p.published_at, today);
    if (age < INDEX_WINDOW_DAYS || age > 42) continue;
    if (!p.indexed_at || (!p.indexed && daysBetween(p.inspected_at || p.published_at, today) >= 3)) {
      if (pastSoft()) { inspectFail = "the run's time budget was used before every page was inspected"; break; }
      const r = await inspectUrl(g.site, p.url, { fetchImpl });
      if (!r.ok) { inspectFail = r.reason; break; }
      p.inspected_at = today; p.indexed = r.indexed; if (r.indexed && !p.indexed_at) p.indexed_at = today;
    }
    measured++; if (p.indexed && daysBetween(p.published_at, p.indexed_at) <= INDEX_WINDOW_DAYS + 7) indexed++;
  }
  res.indexed = live.filter((p) => p.indexed).length;
  if (inspectFail) { res.indexNote = `URL Inspection: ${inspectFail}`; notes.push(`not read: index status for ${measured ? 'some' : 'the'} pages 14-42 days old (${res.indexNote})`); }
  res.indexedRecent = { measured, indexed };

  progress('check', 'checkpoints, strengthen, undo, merge');
  const index = buildIndex(cfg, { withText: true });
  const winners = L.read('winners', { topics: [] });
  const consolidation = L.read('consolidation', { schema: 'search-loop-consolidation-v1', merges: [] });
  // v1.9.0: live pages built before v1.7.1 (a how-to with no numbered steps, template filler) are
  // re-rendered once from their saved draft through today's write path (capRepeats + render). No model call.
  // v1.14.2: a page built before the site changed its one action still ends in the old one (f9).
  // The action line is swapped in place on every live page (no model, no re-render, dates kept);
  // never in mode off (the engine writes nothing then) or on a site whose pages are frozen.
  if (!frozen && rules.build) for (const p of live) if (p.status === 'live' && refreshAction(cfg, L, p, { today, notes })) res.action_refreshed = (res.action_refreshed || 0) + 1;
  if (rules.strengthen) for (const p of live) if (reshape(cfg, L, p, { today, index, notes })) res.reshaped = (res.reshaped || 0) + 1;
  for (const p of live) {
    const due = dueCheckpoints(p, today);
    const strengthenDue = p.strengthen && !p.strengthen.verdict && daysBetween(p.strengthen.at, today) >= STRENGTHEN_SETTLE_DAYS;
    if (!due.length && !strengthenDue) continue;
    const m = g.map?.get(p.url);
    const snap = g.notRead ? { source: 'not read', note: g.notRead } : { source: 'search_console', clicks: m?.clicks || 0, impressions: m?.impressions || 0, position: m?.position ?? null };
    const day = daily.days[today];
    snap.ai_visits_today = day?.ai_visitors?.by_path?.[p.route] ?? ((day?.ai_visitors_not_read || day?.not_read) ? `not read: ${day.ai_visitors_not_read || day.not_read}` : 0);
    snap.indexed = p.indexed ?? null;
    for (const k of due.length ? due : ['settle']) {
      snap.checkpoint = k;
      res.checked++;
      // v1.6.0: each checkpoint records its lane and whether the page reached the top 3.
      if (k !== 'settle') p.checks[k] = { at: today, ...snap, lane: p.lane || 'striking', ...(snap.source === 'search_console' ? { top3: typeof snap.position === 'number' && snap.position <= 3 } : {}) };
      if (snap.source !== 'search_console') continue;
      for (const act of decide(p, snap, { rules, today })) {
        if (act === 'winner' && !p.winner) { p.winner = today; res.wins++; winners.topics = [...new Set([p.query, ...(winners.topics || [])])].slice(0, 30); }
        if (act === 'keep') p.strengthen.verdict = { at: today, kept: true, position: snap.position };
        if (act === 'undo') { undo(cfg, L, p, today, snap); res.undone++; }
        if (act === 'strengthen') { if ((await strengthen(cfg, L, p, snap, { today, chat, fetchImpl, index, notes })).ok) res.strengthened++; }
        if (act === 'merge') { if (merge(cfg, p, index, g.map, consolidation, book, today, notes)) res.merged++; }
      }
    }
  }
  // v1.14.0 AI answer misses: settle earlier AI-miss strengthens, then strengthen the pages
  // ChatGPT, Gemini or AI Overviews left out (no Search Console position gate; same gate,
  // snapshot and undo). Before REFRESH, so a page strengthened here is not refreshed today.
  if (ai) {
    settleAiMisses(live, ai, { today, notes });
    res.ai_misses = await strengthenAiMisses(cfg, L, live, ai, { today, now, rules, mode, chat, fetchImpl, index, notes, g });
    res.strengthened += res.ai_misses.strengthened;
  }
  // v1.10.0 REFRESH: due pages get their sources re-checked and one real-search question; a date
  // moves only with a change (risk rule R-ADV-12). Never on a frozen site.
  if (!frozen) res.refresh = await refreshPages(cfg, L, live.filter((p) => p.status === 'live'), { today, now, rules, chat, fetchImpl, index, notes });
  // Learning, weekly per site: can-be-#1 weights move with each signal's top-3 hit rate.
  const lw = L.read('lane_weights', null);
  const learned = learnWeights(book.pages, lw, { week: isoWeek(now) });
  if (!lw || lw.week !== learned.week) L.write('lane_weights', { schema: 'search-loop-lane-weights-v1', week: learned.week, weights: learned.weights, log: learned.log });
  for (const c of learned.changes) notes.push(`CHECK learning: can-be-#1 weight "${c.signal}" ${c.from} -> ${c.to} (${c.why})`);
  res.weight_changes = learned.changes;
  L.write('winners', winners);
  L.write('consolidation', consolidation);
  L.write('pages', book);
  runs.last_check = today;
  L.write('runs', runs);
  return res;
}

function undo(cfg, L, p, today, snap) {
  const snapFile = L.snapshotPath(p.strengthen.before_hash);
  if (fs.existsSync(snapFile)) { fs.writeFileSync(path.join(cfg.root, p.rel), fs.readFileSync(snapFile)); p.modified_at = today; }
  p.strengthen.verdict = { at: today, undone: true, position: snap.position, reason: `position ${snap.position} is worse than ${p.strengthen.baseline_position} by more than ${UNDO_IF_WORSE_BY}` };
}

// The old page is snapshotted; dates are left alone (the page's words did not change).
export function refreshAction(cfg, L, p, { today, notes = [] }) {
  if (!cfg.action?.url) return false;
  const file = path.join(cfg.root, p.rel);
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const cur = before.match(/<p class="site-action">[\s\S]*?<\/p>/i);
  const want = actionLine(cfg);
  if (!cur || cur[0] === want) return false;
  const html = before.replace(cur[0], want);
  const bh = sha256(before);
  fs.mkdirSync(path.dirname(L.snapshotPath(bh)), { recursive: true });
  fs.writeFileSync(L.snapshotPath(bh), before);
  fs.writeFileSync(file, html);
  p.hash = sha256(html);
  p.action_refreshed = { at: today, before_hash: bh, after_hash: p.hash };
  notes.push(`action: ${p.route} now ends in the site's one action (${cfg.action.url})`);
  return true;
}

export const RESHAPE_VERSION = 2; // v1.9.2: the b4 lead gap (an answer that defines nothing)

// Kept only if the re-render passes the gate with every gap gone; the old page is snapshotted.
// A page that cannot be cleared this way is recorded under RESHAPE_VERSION with what is left, and
// not tried again until a later engine bumps the version (re-rendering the same draft gives the same page).
export function reshape(cfg, L, p, { today, index = [], notes = [] }) {
  if (p.reshaped?.v === RESHAPE_VERSION || (p.strengthen && !p.strengthen.verdict)) return false;
  const draftFile = path.join(L.dir, 'drafts', `${p.slug}.json`);
  const file = path.join(cfg.root, p.rel);
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const gaps = shapeGaps(before, p.query);
  if (!Object.keys(gaps).length) return false;
  const left = (why) => { p.reshaped = { v: RESHAPE_VERSION, at: today, fixed: [], left: why }; notes.push(`reshape of ${p.route} left as it was: ${why.slice(0, 2).join('; ')}`); return false; };
  const saved = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : null;
  const gateOf = (h, facts) => gate({ query: p.query, html: h, facts }, { cfg, corpus: index, selfRoute: p.route });
  let html; let next; let problems;
  if (Object.keys(gaps).join() === 'lead') {
    // v1.9.2: only the lead defines nothing. The live page may have been edited after its draft was
    // saved (p-n-p #203/#206), so the lead paragraph is rewritten in place, never re-rendered; kept
    // only if the page is no worse at the gate than it is now.
    const m = before.match(/<p class="direct-answer">([\s\S]*?)<\/p>/i);
    const lead = defineLead({ direct_answer: m[1] }).direct_answer;
    if (lead === m[1]) return left([gaps.lead, 'the writer cannot rewrite this lead in place; it changes when the page is strengthened']);
    html = before.replace(m[0], `<p class="direct-answer">${lead}</p>`);
    next = saved && defineLead(saved);
    const facts = saved?.facts || [];
    const was = new Set(gateOf(before, facts));
    problems = [...gateOf(html, facts).filter((x) => !was.has(x)), ...Object.values(shapeGaps(html, p.query))];
  } else {
    if (!saved) return left([...Object.values(gaps), 'no saved draft to re-render']);
    const drift = draftDrift(before, saved);
    if (drift.length) return left([...Object.values(gaps), `${EDITED_PAGE} (${drift[0]})`]);
    next = defineLead(capRepeats(saved));
    const relatedLinks = relatedLinksOf(before);
    html = render(cfg, { slug: p.slug, draft: next, related: relatedLinks, published: p.published_at, modified: today });
    const after = shapeGaps(html, p.query);
    // A lead the writer cannot rewrite never blocks the other fixes; it was already there and is no worse.
    const stillOk = (k) => k === 'lead' && gaps.lead && Object.keys(gaps).some((g) => g !== 'lead' && !after[g]);
    problems = [...gateOf(html, next.facts || []), ...Object.entries(after).filter(([k]) => !stillOk(k)).map(([, v]) => v)];
  }
  if (problems.length) return left(problems);
  const after = shapeGaps(html, p.query);
  const bh = sha256(before);
  fs.mkdirSync(path.dirname(L.snapshotPath(bh)), { recursive: true });
  fs.writeFileSync(L.snapshotPath(bh), before);
  fs.writeFileSync(file, html);
  if (next) fs.writeFileSync(draftFile, JSON.stringify(next, null, 2) + '\n');
  p.hash = sha256(html);
  p.modified_at = today;
  p.reshaped = { v: RESHAPE_VERSION, at: today, fixed: Object.keys(gaps).filter((k) => !after[k]), before_hash: bh, after_hash: p.hash };
  notes.push(`reshape: ${p.route} re-rendered (${p.reshaped.fixed.join(', ')})`);
  return true;
}

// Strengthen one page: 1-2 new sections and 1 FAQ from the free model, through the same gate,
// snapshot (undo restores those bytes) and render as BUILD. `target` (v1.14.0) is an AI-miss
// brief: the prompts the AI answers left the site out of and the sources they cited, in place
// of the page's Search Console queries. Nothing new from the model -> the page, its draft and
// its dates are left exactly as they were (R-ADV-12: no fake freshness).
// Returns {ok:true} or {ok:false, why:'missing'|'edited'|'model'|'nothing'|'gate', reason}.
async function strengthen(cfg, L, p, snap, { today, chat, fetchImpl, index, notes, target = null }) {
  const draftFile = path.join(L.dir, 'drafts', `${p.slug}.json`);
  const file = path.join(cfg.root, p.rel);
  if (!fs.existsSync(draftFile) || !fs.existsSync(file)) return { ok: false, why: 'missing', reason: 'no saved draft or page file to strengthen' };
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const drift = draftDrift(fs.readFileSync(file, 'utf8'), draft);
  if (drift.length) {
    const reason = `${EDITED_PAGE} (${drift[0]})`;
    notes.push(`strengthen of ${p.route}: ${reason}`);
    return { ok: false, why: 'edited', reason };
  }
  let queries; let ask;
  if (target?.kind === 'ai_miss') {
    queries = [...new Set(target.prompts)];
    const cited = [...new Set(target.sources)].slice(0, 8);
    ask = `ChatGPT, Gemini or Google AI Overviews answer these buyer questions without naming this page: ${queries.join(' | ')}.\n${cited.length ? `The answers cite: ${cited.join(' ')} (context only; never copy them or name them as sources).\n` : ''}Write what this page is missing to answer those questions directly and completely.`;
  } else {
    const site = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'];
    const q = await searchAnalytics(site, { startDate: dateDaysAgo(31), endDate: dateDaysAgo(3), dimensions: ['query'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: p.url }] }], rowLimit: 20 }, { fetchImpl });
    queries = [...new Set([...(q.ok ? q.rows.map((r) => r.keys[0]) : [p.query]), ...(p.extra_queries || [])])];
    ask = `The page "${draft.h1}" sits just off page one for: ${queries.join(' | ')}.`;
  }
  const r = await chat({ cfg, fetchImpl, messages: [
    { role: 'system', content: `You improve one page for ${cfg.site_name}. Audience: ${cfg.audience}. Voice: ${cfg.voice}. Return ONLY JSON.` },
    { role: 'user', content: `${ask}\nThe page is "${draft.h1}". Its sections: ${draft.sections.map((s) => s.heading).join(' | ')}.\nReturn {"sections":[{"heading":"a question from the searches not yet answered","paragraphs":["120-180 words"]}],"faq":[{"q":"...","a":"40-60 words"}]} with 1-2 new sections and 1 new FAQ. No statistics, named people, credentials, reviews or outcome promises.` },
  ] });
  if (!r.ok) { notes.push(`strengthen skipped for ${p.route}: ${r.reason}`); return { ok: false, why: 'model', reason: r.reason }; }
  const add = parseJsonAnswer(r.answer) || {};
  const had = new Set([...draft.sections.map((s) => norm(s.heading)), ...draft.faq.map((f) => norm(f.q))]);
  const newSections = (Array.isArray(add.sections) ? add.sections : []).filter((s) => typeof s?.heading === 'string' && Array.isArray(s.paragraphs) && s.paragraphs.length && !had.has(norm(s.heading))).slice(0, 2);
  const newFaq = (Array.isArray(add.faq) ? add.faq : []).filter((f) => typeof f?.q === 'string' && typeof f?.a === 'string' && f.q && f.a && !had.has(norm(f.q)));
  const next = capRepeats({ ...draft, sections: [...draft.sections, ...newSections], faq: [...draft.faq, ...newFaq].slice(0, 6) });
  if (JSON.stringify([next.sections, next.faq]) === JSON.stringify([draft.sections, draft.faq])) {
    notes.push(`strengthen of ${p.route}: the model added nothing new; the page and its dates are unchanged`);
    return { ok: false, why: 'nothing', reason: 'the model added nothing new; the page and its dates are unchanged' };
  }
  next.facts = await verifyFacts(next.facts || [], fetchImpl);
  const before = fs.readFileSync(file, 'utf8');
  const relatedLinks = relatedLinksOf(before);
  const html = render(cfg, { slug: p.slug, draft: next, related: relatedLinks, published: p.published_at, modified: today });
  const problems = gate({ query: p.query, html, facts: next.facts }, { cfg, corpus: index, selfRoute: p.route });
  if (problems.length) { notes.push(`strengthen of ${p.route} failed the gate, left as it was: ${problems.slice(0, 2).join('; ')}`); return { ok: false, why: 'gate', reason: `failed the gate, left as it was: ${problems.slice(0, 2).join('; ')}` }; }
  const bh = sha256(before);
  fs.mkdirSync(path.dirname(L.snapshotPath(bh)), { recursive: true });
  fs.writeFileSync(L.snapshotPath(bh), before);
  fs.writeFileSync(file, html);
  fs.writeFileSync(draftFile, JSON.stringify(next, null, 2) + '\n');
  p.modified_at = today;
  if (p.strengthen) p.strengthen_history = [...(p.strengthen_history || []), p.strengthen].slice(-10);
  p.strengthen = { at: today, before_hash: bh, after_hash: sha256(html), baseline_position: snap.position ?? null, queries, ...(target?.kind === 'ai_miss' ? { trigger: 'ai_miss', ai_miss_ids: target.ids, week: target.week } : {}) };
  return { ok: true };
}

// An AI-miss strengthen settles once Boss OS has read a newer week: no longer listed ->
// kept:'ai_miss'; still listed -> kept, still_missed (Boss OS counts fix_attempts). A null
// Search Console baseline never blocks this. No newer read in 28 days -> settled as not read.
export function settleAiMisses(live, ai, { today, notes = [] }) {
  for (const p of live) {
    const s = p.strengthen;
    if (!s || s.verdict || s.trigger !== 'ai_miss') continue;
    const age = daysBetween(s.at, today);
    if (age < STRENGTHEN_SETTLE_DAYS) continue;
    if (ai?.ok && String(ai.week) > String(s.week)) {
      const listed = new Set([...ai.misses.map((m) => m.id), ...ai.rejected.map((r) => r.id)]);
      const still = (s.ai_miss_ids || []).filter((id) => listed.has(id));
      s.verdict = still.length ? { at: today, kept: true, still_missed: still, week: ai.week } : { at: today, kept: 'ai_miss', week: ai.week };
      notes.push(`AI misses: ${p.route} ${still.length ? `is still left out of ${still.length} AI answer(s) in ${ai.week}` : `is no longer listed as missed in ${ai.week}`}`);
    } else if (age >= AI_MISS_SETTLE_MAX_DAYS) {
      s.verdict = { at: today, kept: true, ai_miss: `not read: no newer read of AI answer misses in ${AI_MISS_SETTLE_MAX_DAYS} days` };
    }
  }
}

// One action per miss id per Boss OS week (ledger ai-misses.json). A skip a later run could
// clear is left unrecorded (ai.skipped, this run's report only) so that run acts.
export async function strengthenAiMisses(cfg, L, live, ai, { today, rules, mode, chat, fetchImpl, index, notes, g }) {
  const out = { strengthened: 0, pages: [] };
  if (!ai.ok) return out;
  const book = aiLedger(L);
  for (const r of ai.rejected) if (ID_RE.test(r.id)) recordAction(book, ai.week, r.id, { action: 'rejected', reason: r.reason, at: today });
  const groups = new Map();
  for (const m of ai.misses) {
    if (!m.page_url || actionFor(book, ai.week, m.id)) continue;
    const p = live.find((x) => samePage(x.url, m.page_url));
    if (!p) { recordAction(book, ai.week, m.id, { action: 'skipped', reason: 'not an engine page', page_url: m.page_url, at: today }); continue; }
    if (!groups.has(p.slug)) groups.set(p.slug, { p, misses: [] });
    groups.get(p.slug).misses.push(m);
  }
  let done = 0;
  for (const { p, misses } of groups.values()) {
    const later = (reason) => { for (const m of misses) ai.skipped.push({ id: m.id, reason }); };
    const once = (action, reason) => { for (const m of misses) recordAction(book, ai.week, m.id, { action, page_url: p.url, at: today, ...(reason ? { reason } : {}) }); };
    const s = p.strengthen;
    if (!rules.strengthen) { later(`mode=${mode} does not strengthen pages`); continue; }
    // At most one strengthen per page per 14 days: one settles no sooner than STRENGTHEN_SETTLE_DAYS.
    if (s && !s.verdict) { later(`a strengthen on this page from ${s.at} is still settling (at most one per page per ${STRENGTHEN_SETTLE_DAYS} days)`); continue; }
    if (done >= AI_MISS_PAGES_PER_RUN) { later(`this run's limit of ${AI_MISS_PAGES_PER_RUN} AI-miss strengthens was reached; the next run takes it`); continue; }
    if (pastSoft()) { later("the run's time budget was used; the next run takes it"); continue; }
    const position = g?.map?.get(p.url)?.position ?? null;
    const r = await strengthen(cfg, L, p, { position }, { today, chat, fetchImpl, index, notes, target: { kind: 'ai_miss', ids: misses.map((m) => m.id), prompts: misses.map((m) => m.prompt), sources: misses.flatMap((m) => m.cited_sources), week: ai.week } });
    if (r.ok) { done++; out.strengthened++; out.pages.push(p.url); once('strengthened'); notes.push(`AI misses: strengthened ${p.route} for ${misses.length} AI answer miss(es)`); }
    else if (r.why === 'model') later(`no free model answered (${r.reason})`);
    else once('skipped', r.reason);
  }
  saveAiLedger(L, book);
  return out;
}

function merge(cfg, p, index, gmap, consolidation, book, today, notes) {
  const candidates = [
    ...book.pages.filter((x) => x.status === 'live' && x.slug !== p.slug).map((x) => ({ route: x.route, title: x.query, impressions: gmap?.get(x.url)?.impressions || 0 })),
    ...index.filter((x) => !x.route.startsWith(cfg.output.url_prefix)).map((x) => ({ route: x.route, title: x.h1 || x.title, impressions: gmap?.get(cfg.base_url + x.route)?.impressions || 0 })),
  ].map((c) => ({ ...c, s: tokenOverlap(c.title, p.query) })).filter((c) => c.s >= 0.34).sort((a, b) => (b.impressions > 0) - (a.impressions > 0) || b.s - a.s);
  const into = candidates[0];
  if (!into) { notes.push(`merge: no stronger page for ${p.route}; kept`); return false; }
  const line = addRedirect(cfg, p, into.route);
  const file = path.join(cfg.root, p.rel);
  if (fs.existsSync(file)) fs.rmSync(file);
  if (cfg.output.format === 'dir-index') { try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty */ } }
  for (const h of p.linked_from || []) {
    const f = path.join(cfg.root, h.rel);
    if (fs.existsSync(f)) fs.writeFileSync(f, withoutRelatedLink(fs.readFileSync(f, 'utf8'), p.route));
  }
  p.status = 'merged';
  p.merged = { at: today, into: into.route, reason: '90 days with no impressions' };
  consolidation.merges.push({ at: today, from: p.route, into: into.route, query: p.query, reason: '90 days with no Search Console impressions', redirect: line });
  return true;
}

// Redirect written where the site keeps its redirects: Cloudflare/Netlify
// "_redirects" lines by default, or a JSON list the site's build turns into rules.
export function addRedirect(cfg, p, target) {
  const r = cfg.output.redirects || { file: cfg.output.redirects_file || '_redirects', format: 'lines' };
  const file = path.join(cfg.root, r.file);
  const line = `${p.route} ${target} 301`;
  if (r.format === 'json-list') {
    const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { [r.list_key || 'redirects']: [] };
    const list = j[r.list_key || 'redirects'] ||= [];
    const source = r.source_form === 'rel' ? p.rel : p.route;
    if (!list.some((x) => x[r.source_field || 'source'] === source)) list.push({ [r.source_field || 'source']: source, [r.target_field || 'target']: target, ...(r.extra || {}) });
    if (r.count_key) j[r.count_key] = list.length;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  } else {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!cur.includes(line)) fs.writeFileSync(file, cur.replace(/\n?$/, '\n') + line + '\n');
  }
  return line;
}
