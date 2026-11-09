// CHECK + REPAIR: every page at 2/4/8 weeks (and 90 days). Winners seed more
// pages on their topic; pages near page 1 are strengthened with a before/after
// hash and an automatic undo if they get worse; 90 days with no impressions ->
// merged into a stronger page with a 301.
import fs from 'node:fs';
import path from 'node:path';
import { ledger } from './ledger.mjs';
import { searchAnalytics, inspectUrl, dateDaysAgo } from './gsc.mjs';
import { cloudflareDay } from './analytics.mjs';
import { centralDate, isoWeek, daysBetween, sha256, fetchText, tokenOverlap, pastSoft, progress } from './util.mjs';
import { render, withoutRelatedLink } from './render.mjs';
import { gate } from './gate.mjs';
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { buildIndex } from './site-index.mjs';
import { verifyFacts, capRepeats, shapeGaps, defineLead } from './build.mjs';
import { publishedFrozen } from './config.mjs';
import { learnWeights } from './compete.mjs';

export const CHECKPOINTS = [['w2', 14], ['w4', 28], ['w8', 56], ['d90', 90]];
export const NEAR_PAGE_ONE = [10.5, 20];
export const UNDO_IF_WORSE_BY = 2;
export const STRENGTHEN_SETTLE_DAYS = 14;
export const INDEX_WINDOW_DAYS = 14;

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
    out.push(snap.position > s.baseline_position + UNDO_IF_WORSE_BY ? (rules.undo ? 'undo' : 'hold') : 'keep');
  }
  if (!s && rules.strengthen && snap.position != null && snap.position >= NEAR_PAGE_ONE[0] && snap.position <= NEAR_PAGE_ONE[1] && ['w4', 'w8'].includes(snap.checkpoint)) out.push('strengthen');
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

export async function check(cfg, { rules: modeRules, mode, now = new Date(), fetchImpl = fetch, chat = freeChat, notes = [] } = {}) {
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

  if (res.skipped) { L.write('pages', book); return res; }

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
        if (act === 'strengthen') { if (await strengthen(cfg, L, p, snap, { today, chat, fetchImpl, index, notes })) res.strengthened++; }
        if (act === 'merge') { if (merge(cfg, p, index, g.map, consolidation, book, today, notes)) res.merged++; }
      }
    }
  }
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
  if (fs.existsSync(snapFile)) fs.writeFileSync(path.join(cfg.root, p.rel), fs.readFileSync(snapFile));
  p.strengthen.verdict = { at: today, undone: true, position: snap.position, reason: `position ${snap.position} is worse than ${p.strengthen.baseline_position} by more than ${UNDO_IF_WORSE_BY}` };
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
    next = defineLead(capRepeats(saved));
    const relatedLinks = [...before.matchAll(/data-search-loop="related"[\s\S]*?<\/section>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)">([^<]+)</g)].map((x) => ({ route: x[1], anchor: x[2] })));
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
  p.reshaped = { v: RESHAPE_VERSION, at: today, fixed: Object.keys(gaps).filter((k) => !after[k]), before_hash: bh, after_hash: p.hash };
  notes.push(`reshape: ${p.route} re-rendered (${p.reshaped.fixed.join(', ')})`);
  return true;
}

async function strengthen(cfg, L, p, snap, { today, chat, fetchImpl, index, notes }) {
  const draftFile = path.join(L.dir, 'drafts', `${p.slug}.json`);
  const file = path.join(cfg.root, p.rel);
  if (!fs.existsSync(draftFile) || !fs.existsSync(file)) return false;
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const site = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'];
  const q = await searchAnalytics(site, { startDate: dateDaysAgo(31), endDate: dateDaysAgo(3), dimensions: ['query'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: p.url }] }], rowLimit: 20 }, { fetchImpl });
  const queries = [...new Set([...(q.ok ? q.rows.map((r) => r.keys[0]) : [p.query]), ...(p.extra_queries || [])])];
  const r = await chat({ cfg, fetchImpl, messages: [
    { role: 'system', content: `You improve one page for ${cfg.site_name}. Audience: ${cfg.audience}. Voice: ${cfg.voice}. Return ONLY JSON.` },
    { role: 'user', content: `The page "${draft.h1}" sits just off page one for: ${queries.join(' | ')}.\nIts sections: ${draft.sections.map((s) => s.heading).join(' | ')}.\nReturn {"sections":[{"heading":"a question from the searches not yet answered","paragraphs":["120-180 words"]}],"faq":[{"q":"...","a":"40-60 words"}]} with 1-2 new sections and 1 new FAQ. No statistics, named people, credentials, reviews or outcome promises.` },
  ] });
  if (!r.ok) { notes.push(`strengthen skipped for ${p.route}: ${r.reason}`); return false; }
  const add = parseJsonAnswer(r.answer) || {};
  const next = capRepeats({ ...draft, sections: [...draft.sections, ...(add.sections || []).filter((s) => s?.heading && s?.paragraphs?.length).slice(0, 2)], faq: [...draft.faq, ...(add.faq || []).filter((f) => f?.q && f?.a)].slice(0, 6) });
  next.facts = await verifyFacts(next.facts || [], fetchImpl);
  const before = fs.readFileSync(file, 'utf8');
  const relatedLinks = [...before.matchAll(/data-search-loop="related"[\s\S]*?<\/section>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)">([^<]+)</g)].map((x) => ({ route: x[1], anchor: x[2] })));
  const html = render(cfg, { slug: p.slug, draft: next, related: relatedLinks, published: p.published_at, modified: today });
  const problems = gate({ query: p.query, html, facts: next.facts }, { cfg, corpus: index, selfRoute: p.route });
  if (problems.length) { notes.push(`strengthen of ${p.route} failed the gate, left as it was: ${problems.slice(0, 2).join('; ')}`); return false; }
  const bh = sha256(before);
  fs.mkdirSync(path.dirname(L.snapshotPath(bh)), { recursive: true });
  fs.writeFileSync(L.snapshotPath(bh), before);
  fs.writeFileSync(file, html);
  fs.writeFileSync(draftFile, JSON.stringify(next, null, 2) + '\n');
  p.strengthen = { at: today, before_hash: bh, after_hash: sha256(html), baseline_position: snap.position, queries };
  return true;
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
