// AI answer misses (v1.14.0): the buyer questions where ChatGPT, Gemini or Google AI
// Overviews left this site out, read once per run from Boss OS (CONTRACT.md, 22 Nov 2026).
// A miss naming one of the engine's live pages strengthens that page (CHECK, src/check.mjs);
// a miss with no page becomes a FIND candidate (src/find.mjs). Everything Boss OS sends is
// treated as untrusted: an off-host or odd URL, a repeated id or a bad row is rejected and
// counted, and never fetched or edited. Any failed read is "could not tell", never "no misses".
import { centralDate, daysBetween } from './util.mjs';

export const AI_MISSES_URL = 'https://boss.sequoiataylor.com/api/boss/growth/ai-misses';
export const AI_MISSES_SCHEMA = 'search-loop-ai-misses-v1';
export const MAX_MISSES = 100;
export const ID_RE = /^[0-9a-f]{40}$/; // sha1(host + prompt), CONTRACT.md
export const WEEK_RE = /^\d{4}-W\d{2}$/;
const KEEP_WEEKS = 8;
const KEEP_READS = 60;

export const bareHost = (cfg) => new URL(cfg.base_url).hostname.toLowerCase().replace(/^www\./, '');

// A test or proof run may point the reader at a fixture on this machine only, so the
// token can never be sent anywhere but Boss OS or the runner itself.
export function endpoint(env = process.env) {
  const o = env.SEARCH_LOOP_AI_MISSES_URL;
  if (!o) return AI_MISSES_URL;
  try { const u = new URL(o); if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return o; } catch { /* not a URL */ }
  return AI_MISSES_URL;
}

const clean = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const httpUrl = (s) => { try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u : null; } catch { return null; } };

// The page a miss names, checked against this site. Returns {url} (normalised) or {reject}.
export function checkPageUrl(raw, cfg) {
  if (typeof raw !== 'string' || raw.length > 500) return { reject: 'page_url is not a string URL' };
  // Before the URL parser folds them away: dot segments, encoded dots or slashes, backslashes.
  if (/\.\.|%2e|%2f|%5c|\\/i.test(raw)) return { reject: 'page_url has a path outside the site (dot segments, encoded dots or slashes)' };
  const u = httpUrl(raw);
  if (!u) return { reject: 'page_url is not an http(s) URL' };
  const site = new URL(cfg.base_url);
  if (u.hostname.toLowerCase().replace(/^www\./, '') !== bareHost(cfg)) return { reject: `page_url is on ${u.hostname}, not ${bareHost(cfg)}` };
  if (u.port && u.port !== site.port) return { reject: 'page_url names another port' };
  return { url: `${site.origin}${u.pathname.replace(/\/+$/, '') || '/'}` };
}

// Same address, ignoring www, a trailing slash, a query and a fragment.
export const samePage = (a, b) => {
  const k = (x) => { const u = httpUrl(x); return u ? `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}` : null; };
  return k(a) != null && k(a) === k(b);
};

const couldNotTell = (reason, extra = {}) => ({ ok: false, status: 'could_not_tell', reason, misses: [], rejected: [], ...extra });

// GET the misses. Never throws: every failure is {ok:false, status:'could_not_tell', reason}.
export async function readAiMisses(cfg, { fetchImpl = fetch, token = process.env.BOSS_OPEN_LOOPS_TOKEN, env = process.env, timeoutMs = 15000 } = {}) {
  if (!token) return couldNotTell('no BOSS_OPEN_LOOPS_TOKEN in this run (pass it in the caller\'s secrets: block)');
  const host = bareHost(cfg);
  const url = `${endpoint(env)}?host=${encodeURIComponent(host)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let status; let text;
  try {
    // A redirect is never followed: the token goes to Boss OS and nowhere else.
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: ctrl.signal, redirect: 'manual' });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return couldNotTell(ctrl.signal.aborted ? `Boss OS did not answer in ${Math.round(timeoutMs / 1000)}s` : `Boss OS could not be reached (${clean(e?.message || e, 120)})`);
  } finally { clearTimeout(t); }
  if (status === 401 || status === 403) return couldNotTell(`Boss OS refused the token (HTTP ${status})`);
  if (status === 404) return couldNotTell(`Boss OS does not know ${host} (HTTP 404)`);
  if (status !== 200) return couldNotTell(`Boss OS answered HTTP ${status}`);
  let body;
  try { body = JSON.parse(text); } catch { return couldNotTell('Boss OS sent a body that is not JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return couldNotTell('Boss OS sent a body that is not an object');
  if (String(body.host || '').toLowerCase().replace(/^www\./, '') !== host) return couldNotTell(`Boss OS answered for "${clean(body.host ?? '', 80)}", not ${host}`);
  if (!WEEK_RE.test(String(body.week || ''))) return couldNotTell('Boss OS sent no ISO week (e.g. 2026-W48)');
  if (body.status === 'not_read') return couldNotTell(`Boss OS did not read AI answers in ${body.week} (status not_read)`, { week: body.week });
  if (body.status !== 'read') return couldNotTell(`Boss OS sent status "${clean(body.status ?? '', 40)}", not read or not_read`, { week: body.week });
  if (!Array.isArray(body.misses)) return couldNotTell('Boss OS sent no misses list', { week: body.week });
  return { ok: true, status: 'read', week: body.week, read_at: typeof body.read_at === 'string' ? clean(body.read_at, 40) : null, ...vetMisses(body.misses, cfg) };
}

// Each row on its own: a bad row is rejected (with why), the others are used.
export function vetMisses(rows, cfg) {
  const rejected = [];
  const ids = rows.map((m) => (m && typeof m.id === 'string' ? m.id : null));
  const count = new Map();
  for (const id of ids) if (id) count.set(id, (count.get(id) || 0) + 1);
  const misses = [];
  rows.forEach((m, i) => {
    const id = ids[i];
    const rej = (reason) => rejected.push({ id: id && ID_RE.test(id) ? id : `row ${i + 1}`, reason });
    if (!m || typeof m !== 'object') return rej('not an object');
    if (!id || !ID_RE.test(id)) return rej('id is not a sha1 hex string');
    // Two rows with one id cannot both be right: neither is used.
    if (count.get(id) > 1) return rej(`id appears ${count.get(id)} times in one read`);
    if (i >= MAX_MISSES) return rej(`over the ${MAX_MISSES}-miss limit for one read`);
    if (m.lane !== 'own') return rej(`lane is "${clean(m.lane ?? '', 20)}", not own`);
    if (typeof m.prompt !== 'string') return rej('prompt is not text');
    const prompt = clean(m.prompt, 400);
    if (prompt.length < 8 || prompt.length > 300) return rej('prompt is under 8 or over 300 characters');
    let page = null;
    if (m.page_url !== null && m.page_url !== undefined) {
      const c = checkPageUrl(m.page_url, cfg);
      if (c.reject) return rej(c.reject);
      page = c.url;
    }
    const cited = (Array.isArray(m.cited_sources) ? m.cited_sources : []).filter((s) => typeof s === 'string' && s.length <= 300 && httpUrl(s)).slice(0, 8).map((s) => clean(s, 300));
    const engines = (Array.isArray(m.engines_missed) ? m.engines_missed : []).filter((s) => typeof s === 'string').map((s) => clean(s, 40)).slice(0, 6);
    misses.push({ id, prompt, page_url: page, engines_missed: engines, cited_sources: cited });
  });
  return { misses, rejected };
}

// ---- ledger: ai-misses.json -------------------------------------------------
// weeks[<Boss OS week>][<miss id>] = { action, at, page_url?, reason? }: one action per id per week.
// A skip that a later run could clear (mode, a strengthen still settling, the run's limit) is
// never recorded here, so that later run acts.
export function aiLedger(L) {
  const j = L.read('ai_misses', null) || {};
  return { schema: AI_MISSES_SCHEMA, weeks: j.weeks && typeof j.weeks === 'object' ? j.weeks : {}, reads: Array.isArray(j.reads) ? j.reads : [] };
}

export const actionFor = (book, week, id) => (WEEK_RE.test(week) && ID_RE.test(id) ? book.weeks[week]?.[id] || null : null);

export function recordAction(book, week, id, rec) {
  if (!WEEK_RE.test(week) || !ID_RE.test(id)) return false;
  book.weeks[week] ||= {};
  if (book.weeks[week][id]) return false;
  book.weeks[week][id] = rec;
  return true;
}

export function recordRead(book, r, now) {
  book.reads.push({ at: now.toISOString(), status: r.status, ...(r.week ? { week: r.week } : {}), ...(r.ok ? { misses: r.misses.length, rejected: r.rejected.length } : { reason: r.reason }) });
}

export function saveAiLedger(L, book) {
  const weeks = Object.keys(book.weeks).filter((w) => WEEK_RE.test(w)).sort().slice(-KEEP_WEEKS);
  L.write('ai_misses', { schema: AI_MISSES_SCHEMA, weeks: Object.fromEntries(weeks.map((w) => [w, book.weeks[w]])), reads: book.reads.slice(-KEEP_READS) });
}

const readDay = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? null : centralDate(d); };

// The week report's ai_misses block: the last 7 days from the ledger plus this run's own skips.
export function aiMissesBlock(L, { now = new Date(), run = null } = {}) {
  const today = centralDate(now);
  const book = aiLedger(L);
  const within7 = (iso) => { const d = String(iso || '').slice(0, 10); return d && daysBetween(d, today) >= 0 && daysBetween(d, today) < 7; };
  const last = run?.read || book.reads[book.reads.length - 1] || null;
  const out = {
    read: !last ? 'not read: no read of AI answer misses yet' : last.status === 'read' ? 'ok' : `not read: ${last.reason}`,
    week: last?.week || null,
    misses: last?.status === 'read' ? last.misses : 0,
    strengthened: [], new_candidates: [], skipped: [], rejected: [],
    // A read's `at` is a UTC instant; the week report counts days in Central. Counted by its UTC
    // date, an evening read (after 18:00 CST / 19:00 CDT) is "tomorrow" and was left out, so an
    // outage at 23:30 CT reported could_not_tell 0 (keepmyproof proof run, 22 Nov 2026).
    could_not_tell: book.reads.filter((r) => r.status !== 'read' && within7(readDay(r.at))).length,
  };
  for (const w of Object.keys(book.weeks).sort()) {
    for (const [id, a] of Object.entries(book.weeks[w])) {
      if (!within7(a.at)) continue;
      if (a.action === 'strengthened') out.strengthened.push({ id, page_url: a.page_url, at: a.at });
      else if (a.action === 'candidate') out.new_candidates.push({ id, prompt: a.prompt, at: a.at });
      else if (a.action === 'rejected') out.rejected.push({ id, reason: a.reason });
      else out.skipped.push({ id, reason: a.reason });
    }
  }
  const seen = new Set(out.skipped.map((s) => s.id));
  for (const s of run?.skipped || []) if (!seen.has(s.id)) { seen.add(s.id); out.skipped.push({ id: s.id, reason: s.reason }); }
  // Rejected rows with no usable id are counted from this run.
  for (const r of run?.rejected || []) if (!ID_RE.test(r.id)) out.rejected.push({ id: r.id, reason: r.reason });
  return out;
}

export function checkAiMissesBlock(x) {
  const p = [];
  if (!x || typeof x !== 'object') return ['ai_misses must be an object'];
  if (!(x.read === 'ok' || (typeof x.read === 'string' && x.read.startsWith('not read: ')))) p.push('ai_misses.read must be "ok" or "not read: <reason>"');
  if (!Number.isInteger(x.could_not_tell) || x.could_not_tell < 0) p.push('ai_misses.could_not_tell must be a count');
  if (!Array.isArray(x.strengthened) || x.strengthened.some((s) => !s || typeof s.id !== 'string' || !/^https?:\/\//.test(String(s.page_url)) || typeof s.at !== 'string')) p.push('ai_misses.strengthened must be a list of {id, page_url, at}');
  if (!Array.isArray(x.new_candidates) || x.new_candidates.some((s) => !s || typeof s.id !== 'string' || typeof s.prompt !== 'string')) p.push('ai_misses.new_candidates must be a list of {id, prompt, at}');
  for (const k of ['skipped', 'rejected']) if (!Array.isArray(x[k]) || x[k].some((s) => !s || typeof s.id !== 'string' || typeof s.reason !== 'string' || !s.reason)) p.push(`ai_misses.${k} must be a list of {id, reason}`);
  return p;
}
