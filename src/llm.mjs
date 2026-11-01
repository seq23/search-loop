// The free model route. $0 only: every model must be priced 0/0, a response
// reporting usage.cost > 0 throws, and there is no paid fallback. A site may
// point llm.routing_file at its own routing file (same shape as
// sprylabs-hpc-site config/llm_routing.json); otherwise config/free-models.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROUTING = path.join(ENGINE_ROOT, 'config', 'free-models.json');

export function loadRouting(cfg) {
  const file = cfg?.llm?.routing_file ? path.resolve(cfg.root, cfg.llm.routing_file) : DEFAULT_ROUTING;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r?.policy?.max_cost_usd !== 0) throw new Error(`FAIL_LOUD ${file}: policy.max_cost_usd must be 0`);
  if (r?.policy?.fallback_to_paid !== false) throw new Error(`FAIL_LOUD ${file}: policy.fallback_to_paid must be false`);
  const models = (r.free_models || []).filter((m) => String(m?.pricing?.prompt) === '0' && String(m?.pricing?.completion) === '0');
  if (!models.length || models.length !== (r.free_models || []).length) throw new Error(`FAIL_LOUD ${file}: every model must be priced $0/$0 and at least one listed`);
  return { file, endpoint: r.policy.endpoint || 'https://openrouter.ai/api/v1/chat/completions', models: models.map((m) => m.id) };
}

// Returns { ok, answer, model } or { ok:false, stop, rateLimited, reason, attempts }.
export async function freeChat({ cfg, messages, maxTokens = 3500, apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = fetch, sleepImpl = sleep, timeoutMs = 90000 }) {
  const route = loadRouting(cfg);
  const attempts = [];
  if (!apiKey) return { ok: false, stop: 'FREE_MODEL_KEY_MISSING', reason: 'OPENROUTER_API_KEY is not set as a repository secret, so no page can be written', attempts };
  for (const model of route.models) {
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let res; let payload = {};
      try {
        res = await fetchImpl(route.endpoint, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: maxTokens + 2048, reasoning: { effort: 'low', exclude: true }, usage: { include: true }, provider: { allow_fallbacks: false } }),
        });
        payload = await res.json().catch(() => ({}));
      } catch (e) {
        attempts.push({ model, status: 'error', error: String(e?.message || e).slice(0, 120) });
        break;
      } finally { clearTimeout(t); }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        return { ok: false, stop: 'FREE_MODEL_KEY_REFUSED', reason: `OpenRouter refused the key (HTTP ${res.status})`, attempts };
      }
      const cost = payload?.usage?.cost;
      if (cost !== undefined && cost !== null && Number(cost) !== 0) throw new Error(`FAIL_LOUD ${model} reported usage.cost=${cost}; the route is $0 only`);
      if (res.status === 429) {
        attempts.push({ model, status: 'http_429' });
        const after = Number(res.headers?.get?.('retry-after'));
        if (tryNo === 0 && Number.isFinite(after) && after <= 20) { await sleepImpl(after * 1000); continue; }
        break;
      }
      const answer = payload?.choices?.[0]?.message?.content || '';
      if (!res.ok || !answer.trim()) { attempts.push({ model, status: res.ok ? 'empty' : `http_${res.status}` }); break; }
      return { ok: true, answer, model: payload.model || model, attempts };
    }
  }
  const limited = attempts.filter((a) => a.status === 'http_429').length;
  return { ok: false, stop: 'NO_FREE_MODEL', rateLimited: limited > 0 && limited >= attempts.length / 2, reason: `none of ${route.models.length} free model(s) answered (${attempts.map((a) => `${a.model.split('/').pop()}:${a.status}`).join(', ')})`, attempts };
}

export function parseJsonAnswer(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { return null; }
}
