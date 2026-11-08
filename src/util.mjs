// Shared helpers: named stops, clocks, hashing, text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Exit codes (rule-zero-shapes): 0 work done and visible, 1 problems found,
// 2 nothing checked / not recorded, 3 credential only the owner can fix,
// 9 run did not complete, 75 could not verify.
export const EXIT = { OK: 0, PROBLEMS: 1, NOTHING: 2, CREDENTIAL: 3, INCOMPLETE: 9, UNVERIFIED: 75 };

export class NamedStop extends Error {
  constructor(code, message, exit = EXIT.NOTHING) {
    super(`NAMED STOP [${code}] ${message}`);
    this.stopCode = code;
    this.code = exit;
  }
}

export const namedLine = (kind, code, msg) => `${kind} [${code}] ${msg}`;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function readJson(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export const DAY_MS = 86400000;

// Her clock is America/Chicago: "today" and "this week" are decided there.
export function centralDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isoWeek(now = new Date()) {
  const d = new Date(centralDate(now) + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY_MS);

export function norm(q) {
  return String(q || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set('a an the and or of to for in on at is are be with my your i you me do does how what why when can should vs best way ways it this that from by as'.split(' '));
export const contentWords = (q) => norm(q).split(' ').filter((w) => w && !STOP.has(w));

// A search typed with a slip in its question word ("hot to set up a virtual
// event", Bing suggest via virtualagency-os.com, 6 Nov 2026) became the page's
// address, /questions/hot-to-set-up-a-virtual-event, while the model wrote a
// correct title. The address is the one part nobody re-reads, so the common
// slips in the leading question word are corrected before it is made.
const QUESTION_WORD_SLIPS = [
  [/^(?:hot|hpw|hoe|hiw|hw|hwo|ho) to /, 'how to '],
  [/^how ot /, 'how to '],
  [/^(?:hwo|hw|hpw) /, 'how '],
  [/^(?:waht|whta|wht) /, 'what '],
  [/^(?:whay|wy) /, 'why '],
  [/^(?:wehn|whn) /, 'when '],
  [/^(?:wich|whcih|whihc) /, 'which '],
];
export function fixQuestionWord(q) {
  let s = norm(q);
  for (const [re, to] of QUESTION_WORD_SLIPS) s = s.replace(re, to);
  return s;
}

export function slugify(q, max = 70) {
  const s = fixQuestionWord(q).replace(/\s+/g, '-');
  return s.length <= max ? s : s.slice(0, max).replace(/-[^-]*$/, '');
}

export function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

export function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The inverse of esc for an attribute value read back out of rendered HTML:
// render writes href="${esc(url)}", so a URL with a query string (&) reads back
// as &amp; and never equals the config/fact URL it came from unless decoded.
export const unescAttr = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// 5-word shingles; Jaccard similarity for the near-duplicate check.
export function shingles(text, k = 5) {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function tokenOverlap(a, b) {
  const A = new Set(contentWords(a)); const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every outbound request has a timeout that covers the body too, and a bounded
// retry (network error, timeout, 429, 5xx) — never a hang, never an endless retry.
export async function fetchText(url, { timeoutMs = 20000, headers = {}, method = 'GET', body, fetchImpl = fetch, retries = 1, retryDelayMs } = {}) {
  const delay = retryDelayMs ?? (fetchImpl === fetch ? 1500 : 0);
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(delay * attempt);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      last = { status: res.status, ok: res.ok, text, headers: res.headers };
    } catch (e) {
      last = { status: 0, ok: false, text: '', error: ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e).slice(0, 160) };
    } finally { clearTimeout(t); }
    if (!(last.status === 0 || last.status === 429 || last.status >= 500)) return last;
  }
  return last;
}

export const fetchJson = async (url, opts) => {
  const r = await fetchText(url, opts);
  let json = {};
  try { json = r.text ? JSON.parse(r.text) : {}; } catch { /* not JSON */ }
  return { ...r, json };
};

// The run clock. A run has a soft budget (no new model call, page or inspection
// starts after it; the run finishes, writes its report and commits what it has)
// and a hard ceiling (the watchdog in bin/search-loop.mjs ends the run with
// NAMED STOP [RUN_HUNG] naming the stage it stalled in). Progress lines show
// where time goes, so a stall is visible in the log while it happens.
export const runClock = { start: Date.now(), softAt: Infinity, stage: 'start' };
export function startClock({ softMinutes, now = Date.now() } = {}) {
  runClock.start = now; runClock.stage = 'start';
  runClock.softAt = Number.isFinite(softMinutes) ? now + softMinutes * 60000 : Infinity;
}
export const pastSoft = (now = Date.now()) => now > runClock.softAt;
const quiet = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.SEARCH_LOOP_QUIET === '1';
export function progress(stage, msg = '') {
  runClock.stage = msg ? `${stage}: ${msg}` : stage;
  if (quiet()) return;
  const m = ((Date.now() - runClock.start) / 60000).toFixed(1);
  console.log(`progress +${m}m ${stage}${msg ? ` — ${msg}` : ''}`);
}

export function walkHtml(root, dir, { skip = [] } = {}) {
  const out = [];
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return out;
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
        stack.push(p);
      } else if (e.name.endsWith('.html')) out.push(rel);
    }
  }
  return out.sort();
}
