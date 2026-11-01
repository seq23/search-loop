// The free model lanes. $0 only, three lanes tried in order, with backoff
// across lanes before giving up:
//   1. Gemini API      — free tier only (GEMINI_API_KEY from a project with no billing).
//   2. OpenRouter      — ":free" models priced 0/0 only; a response reporting
//                         usage.cost > 0 throws. Daily free quota exhaustion closes the lane.
//   3. Workers AI      — only inside a metered share of the account's free 10,000 daily
//                         neurons that the studios (8,500) do not hold: the engine's own model's
//                         usage today is read from Cloudflare analytics BEFORE each call and the
//                         lane closes if it cannot be read (fail closed: overage is billed).
// GitHub Models was retired by GitHub on 30 Jul 2026: models.github.ai now answers
// every request with HTTP 200 text/plain "OK", so that lane is gone (v1.2.2).
// A 200 that is not a JSON answer closes its lane for the run (a dead or replaced
// endpoint costs one request per run, never one per model per page).
// No paid lane exists. When every lane is out: NO_FREE_MODEL, and the search stays queued.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, runClock, progress } from './util.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROUTING = path.join(ENGINE_ROOT, 'config', 'free-models.json');

export function loadRouting(cfg) {
  const file = cfg?.llm?.routing_file ? path.resolve(cfg.root, cfg.llm.routing_file) : DEFAULT_ROUTING;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r?.policy?.max_cost_usd !== 0) throw new Error(`FAIL_LOUD ${file}: policy.max_cost_usd must be 0`);
  if (r?.policy?.fallback_to_paid !== false) throw new Error(`FAIL_LOUD ${file}: policy.fallback_to_paid must be false`);
  const models = (r.free_models || []).filter((m) => String(m?.pricing?.prompt) === '0' && String(m?.pricing?.completion) === '0');
  if (!models.length || models.length !== (r.free_models || []).length) throw new Error(`FAIL_LOUD ${file}: every model must be priced $0/$0 and at least one listed`);
  const engine = JSON.parse(fs.readFileSync(DEFAULT_ROUTING, 'utf8'));
  // The site's own roster first, then the engine's (deduped): more free models, same $0 rule.
  const dead = new Set(Object.keys(engine.excluded_models || {}).filter((k) => !k.startsWith('_')));
  const ids = [...new Set([...models.map((m) => m.id), ...(engine.free_models || []).map((m) => m.id)])].filter((id) => id.endsWith(':free') && !dead.has(id));
  return { file, endpoint: r.policy.endpoint || 'https://openrouter.ai/api/v1/chat/completions', models: ids, gemini: engine.gemini_models || [], workers: engine.workers_ai || null };
}

// Per-run lane state, so a lane whose DAILY quota is gone is not re-tried for every page.
// A model that timed out once is skipped for the rest of the run (`slow`), so one
// stuck free model costs one timeout per run, not one per page.
export const laneState = { closed: {}, workersNeurons: 0, slow: {} };
export function resetLanes() { laneState.closed = {}; laneState.workersNeurons = 0; laneState.slow = {}; }

// Time limits (ms). REQUEST: one model call, body included. CALL: one freeChat
// across every lane, model and backoff — the bound that stops a run from hanging
// on a chain of slow free models (heygetonmylevel run 41319477589 sat silent 60 min).
export const LIMITS = { requestMs: 60000, callMs: 4 * 60000 };

async function post(fetchImpl, url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const raw = await res.text();
    let payload = {};
    try { payload = JSON.parse(raw); } catch { payload = { _raw: `${res.headers.get('content-type') || '?'} "${raw.slice(0, 40)}"` }; }
    return { res, payload };
  } catch (e) { return { error: ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e).slice(0, 120), timedOut: ctrl.signal.aborted }; } finally { clearTimeout(t); }
}
// Per-model turn: skip models already slow this run; stop when the call's deadline
// has passed; otherwise the request timeout never runs past the deadline.
function turn(lane, model, { deadline, clock, timeoutMs }) {
  if (laneState.slow[`${lane}:${model}`]) return null;
  const left = deadline - clock();
  if (left <= 0) return null;
  return Math.max(1, Math.min(timeoutMs, left));
}
function failed(lane, model, r, attempts) {
  if (r.timedOut) laneState.slow[`${lane}:${model}`] = r.error;
  attempts.push({ lane, model, status: r.timedOut ? 'timeout' : 'error' });
  progress('model', `${lane} ${model}: ${r.error}`);
}
// A 200 whose body is not JSON is not a model answer: the endpoint is dead or replaced.
function notAnAnswer(lane, model, r, attempts) {
  if (!r.res?.ok || !r.payload?._raw) return false;
  laneState.closed[lane] = `endpoint answered HTTP 200 with no JSON (${r.payload._raw}); closed for the run`;
  attempts.push({ lane, model, status: `non-JSON 200 ${r.payload._raw}` });
  return true;
}
const retryAfter = (res) => { const n = Number(res?.headers?.get?.('retry-after')); return Number.isFinite(n) ? n : null; };

// --- lane 1: Gemini API free tier ------------------------------------------------
// Only with GEMINI_API_KEY from a Google AI Studio project with no billing account
// (free tier cannot be charged). Daily quota gone -> lane closed for the run.
async function geminiLane({ route, messages, maxTokens, fetchImpl, timeoutMs, attempts, deadline, clock }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { laneState.closed.gemini = 'not read: GEMINI_API_KEY is not passed'; return { next: true }; }
  let soonest = null;
  for (const model of route.gemini) {
    const ms = turn('gemini', model, { deadline, clock, timeoutMs }); if (ms == null) continue;
    const r = await post(fetchImpl, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', { authorization: `Bearer ${key}` }, { model, messages, max_tokens: Math.min(maxTokens, 8000), temperature: 0.4, reasoning_effort: 'none' }, ms);
    if (r.error) { failed('gemini', model, r, attempts); continue; }
    if (notAnAnswer('gemini', model, r, attempts)) return { next: true };
    const { res, payload } = r;
    const body = JSON.stringify(payload?.error || payload?.[0]?.error || '');
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key/i.test(body))) { laneState.closed.gemini = `Gemini refused the key (HTTP ${res.status})`; attempts.push({ lane: 'gemini', model, status: `http_${res.status}` }); return { next: true }; }
    if (res.status === 429) {
      attempts.push({ lane: 'gemini', model, status: 'http_429' });
      if (/PerDay|per day|daily/i.test(body)) { laneState.slow[`gemini:${model}`] = 'free daily quota used'; continue; }
      soonest = Math.min(soonest ?? Infinity, retryAfter(res) ?? 30);
      continue;
    }
    const answer = payload?.choices?.[0]?.message?.content || '';
    if (!res.ok || !answer.trim()) { attempts.push({ lane: 'gemini', model, status: (res.ok ? 'empty' : `http_${res.status}`) + (payload?._raw ? ` non-JSON ${payload._raw}` : '') }); continue; }
    return { ok: true, answer, model: `gemini:${model}` };
  }
  if (route.gemini.length && route.gemini.every((m) => laneState.slow[`gemini:${m}`] === 'free daily quota used')) laneState.closed.gemini = 'Gemini free daily quota used up';
  return { retryIn: soonest };
}

// --- lane 2: OpenRouter :free -------------------------------------------------
async function openrouterLane({ route, messages, maxTokens, fetchImpl, timeoutMs, attempts, apiKey, deadline, clock }) {
  if (!apiKey) { laneState.closed.openrouter = 'not read: OPENROUTER_API_KEY is not set'; return { next: true }; }
  let soonest = null;
  for (const model of route.models) {
    const ms = turn('openrouter', model, { deadline, clock, timeoutMs }); if (ms == null) continue;
    const r = await post(fetchImpl, route.endpoint, { authorization: `Bearer ${apiKey}` }, { model, messages, temperature: 0.4, max_tokens: maxTokens + 2048, reasoning: { effort: 'low', exclude: true }, usage: { include: true }, provider: { allow_fallbacks: false } }, ms);
    if (r.error) { failed('openrouter', model, r, attempts); continue; }
    if (notAnAnswer('openrouter', model, r, attempts)) return { next: true };
    const { res, payload } = r;
    if (res.status === 401 || res.status === 402 || res.status === 403) { laneState.closed.openrouter = `OpenRouter refused the key (HTTP ${res.status})`; attempts.push({ lane: 'openrouter', model, status: `http_${res.status}` }); return { next: true, keyRefused: true }; }
    const cost = payload?.usage?.cost;
    if (cost !== undefined && cost !== null && Number(cost) !== 0) throw new Error(`FAIL_LOUD ${model} reported usage.cost=${cost}; the route is $0 only`);
    const msg = String(payload?.error?.message || '');
    if (res.status === 429) {
      attempts.push({ lane: 'openrouter', model, status: 'http_429' });
      if (/free-models-per-day|per day/i.test(msg)) { laneState.closed.openrouter = 'OpenRouter free daily quota used up (free-models-per-day)'; return { next: true }; }
      soonest = Math.min(soonest ?? Infinity, retryAfter(res) ?? 45);
      continue;
    }
    if (res.status === 404) { attempts.push({ lane: 'openrouter', model, status: 'http_404 (model gone)' }); continue; }
    const answer = payload?.choices?.[0]?.message?.content || '';
    if (!res.ok || !answer.trim()) { attempts.push({ lane: 'openrouter', model, status: (res.ok ? 'empty' : `http_${res.status}`) + (payload?._raw ? ` non-JSON ${payload._raw}` : '') }); continue; }
    return { ok: true, answer, model: payload.model || model };
  }
  return { retryIn: soonest };
}

// --- lane 3: Workers AI, metered ------------------------------------------------
export function worstNeurons(w, messages, maxTokens) {
  const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  return Math.ceil((chars / 3) * w.neurons_per_m_input / 1e6 + maxTokens * w.neurons_per_m_output / 1e6);
}

export async function workersUsedToday({ w, fetchImpl, account, token, now = new Date() }) {
  const since = now.toISOString().slice(0, 10) + 'T00:00:00Z'; // the free allowance resets at 00:00 UTC
  const query = `query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:200,filter:{datetime_geq:$s,datetime_lt:$u}){sum{totalNeurons} dimensions{modelId}}}}}`;
  const r = await post(fetchImpl, 'https://api.cloudflare.com/client/v4/graphql', { authorization: `Bearer ${token}` }, { query, variables: { a: account, s: since, u: now.toISOString() } }, 20000);
  if (r.error) return { notRead: r.error };
  const rows = r.payload?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
  if (!Array.isArray(rows)) return { notRead: String(r.payload?.errors?.[0]?.message || `HTTP ${r.res.status}`).slice(0, 120) };
  let mine = 0; let all = 0;
  for (const x of rows) { const n = Number(x?.sum?.totalNeurons || 0); all += n; if (x?.dimensions?.modelId === w.model) mine += n; }
  return { mine, all };
}

async function workersLane({ route, messages, maxTokens, fetchImpl, timeoutMs, attempts, now, deadline, clock }) {
  const w = route.workers;
  // Two tokens: CLOUDFLARE_API_TOKEN reads today's usage (Account Analytics), and
  // CLOUDFLARE_WORKERS_AI_TOKEN runs the model (Workers AI). A token scoped to Workers AI
  // alone cannot read analytics, so one token often cannot do both; the run token falls
  // back to CLOUDFLARE_API_TOKEN when one token holds both scopes.
  const account = process.env.CLOUDFLARE_ACCOUNT_ID; const token = process.env.CLOUDFLARE_API_TOKEN;
  const runToken = process.env.CLOUDFLARE_WORKERS_AI_TOKEN || token;
  if (!w) { laneState.closed.workers = 'not configured'; return { next: true }; }
  if (!account || !token) { laneState.closed.workers = 'not read: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (usage read) not passed'; return { next: true }; }
  const tokens = Math.min(maxTokens, w.max_output_tokens);
  const worst = worstNeurons(w, messages, tokens);
  const used = await workersUsedToday({ w, fetchImpl, account, token, now });
  if (used.notRead) { laneState.closed.workers = `closed: today's Workers AI usage could not be read (${used.notRead}); overage is billed, so the lane fails closed`; return { next: true }; }
  const mine = Math.max(used.mine, laneState.workersNeurons);
  if (mine + worst > w.daily_neuron_cap || used.all + worst > w.account_ceiling) { laneState.closed.workers = `engine share of Workers AI used today (${mine}/${w.daily_neuron_cap} neurons; account ${used.all}/${w.account_ceiling})`; return { next: true }; }
  const ms = turn('workers', w.model, { deadline, clock, timeoutMs }); if (ms == null) return {};
  const r = await post(fetchImpl, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${w.model}`, { authorization: `Bearer ${runToken}` }, { messages, max_tokens: tokens, temperature: 0.4, ...(w.extra_body || {}) }, ms);
  laneState.workersNeurons = mine + worst;
  if (r.error) { failed('workers', w.model, r, attempts); return {}; }
  if (notAnAnswer('workers', w.model, r, attempts)) return { next: true };
  // Older models answer { result: { response } }; newer ones answer OpenAI-shaped { result: { choices } }.
  const answer = r.payload?.result?.response || r.payload?.result?.choices?.[0]?.message?.content || '';
  if (r.res.status === 401 || r.res.status === 403) { laneState.closed.workers = `Workers AI refused the token (HTTP ${r.res.status})`; return { next: true }; }
  if (!r.res.ok || !String(answer).trim()) {
    const why = String(r.payload?.errors?.[0]?.message || '').slice(0, 100);
    if (/not allowed to access|No such model|model.*not found/i.test(why)) { laneState.closed.workers = `Workers AI refused ${w.model}: ${why}`; attempts.push({ lane: 'workers', model: w.model, status: 'model refused' }); return { next: true }; }
    attempts.push({ lane: 'workers', model: w.model, status: (r.res.ok ? 'empty' : `http_${r.res.status}`) + (why ? ` ${why}` : '') }); return {};
  }
  return { ok: true, answer: typeof answer === 'string' ? answer : JSON.stringify(answer), model: `workers:${w.model}` };
}

export const LANES = [['gemini', geminiLane], ['openrouter', openrouterLane], ['workers', workersLane]];
export const BACKOFF = { rounds: 3, maxWaitS: 120, budgetS: 360 };

// Returns { ok, answer, model } or { ok:false, stop, rateLimited, reason, attempts }.
// Bounded in time: every request has LIMITS.requestMs, the whole call LIMITS.callMs
// (lanes, models and backoff together), and no call starts once the run's soft
// budget has passed (stop MODEL_TIME_BUDGET; the search stays queued).
export async function freeChat({ cfg, messages, maxTokens = 3500, apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = fetch, sleepImpl = sleep, timeoutMs = LIMITS.requestMs, callMs = LIMITS.callMs, clock = Date.now, now = new Date() }) {
  const route = loadRouting(cfg);
  const attempts = [];
  if (clock() > runClock.softAt) return { ok: false, stop: 'MODEL_TIME_BUDGET', rateLimited: false, reason: "the run's time budget is used; no new model call starts (the search stays queued)", attempts };
  const deadline = Math.min(clock() + callMs, runClock.softAt);
  let waited = 0;
  for (let round = 0; round < BACKOFF.rounds; round++) {
    let soonest = null;
    for (const [name, lane] of LANES) {
      if (laneState.closed[name]) continue;
      if (clock() >= deadline) break;
      const r = await lane({ route, messages, maxTokens, fetchImpl, timeoutMs, attempts, apiKey, now, deadline, clock });
      if (r.ok) { progress('model', `answered by ${r.model}`); return { ok: true, answer: r.answer, model: r.model, attempts }; }
      if (r.retryIn != null) soonest = Math.min(soonest ?? Infinity, r.retryIn);
    }
    if (clock() >= deadline) { attempts.push({ lane: 'all', status: `call budget ${Math.round(callMs / 1000)}s used` }); break; }
    const open = LANES.filter(([n]) => !laneState.closed[n]);
    if (!open.length || soonest == null || round === BACKOFF.rounds - 1) break;
    const wait = Math.min(BACKOFF.maxWaitS, Math.max(5, soonest) * (round + 1));
    if (waited + wait > BACKOFF.budgetS || clock() + wait * 1000 >= deadline) break;
    progress('model', `every open lane is rate-limited; backing off ${wait}s`);
    attempts.push({ lane: 'all', status: `backoff ${wait}s` });
    await sleepImpl(wait * 1000);
    waited += wait;
  }
  const closed = [...Object.entries(laneState.closed).map(([k, v]) => `${k}: ${v}`), ...Object.entries(laneState.slow).map(([k, v]) => `${k}: ${v} (skipped this run)`)];
  const allKeysMissing = !process.env.GEMINI_API_KEY && !apiKey && !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
  if (allKeysMissing) return { ok: false, stop: 'FREE_MODEL_KEY_MISSING', reason: 'no free model lane has a credential (GEMINI_API_KEY, OPENROUTER_API_KEY, CLOUDFLARE_*)', attempts };
  const limited = attempts.filter((a) => /429|quota|backoff/.test(a.status)).length;
  return { ok: false, stop: 'NO_FREE_MODEL', rateLimited: limited > 0 || Object.values(laneState.closed).some((v) => /quota|share/.test(v)), reason: `every free lane is out — ${closed.join('; ') || 'no lane answered'} (${attempts.slice(-6).map((a) => `${a.lane}:${String(a.model || '').split('/').pop()}:${a.status}`).join(', ')})`, attempts };
}

export function parseJsonAnswer(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { return null; }
}
