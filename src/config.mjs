// Per-site config: search-loop.config.json in the site repo. One definition of
// what a valid config is; validators/validate.mjs and the CLI both call it.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_SCHEMA = 'search-loop-config-v1';
export const HEALTH_GATES = ['none', 'health', 'dental'];
export const PAGE_FORMATS = ['dir-index', 'html-file'];

export const DEFAULTS = {
  mode: 'normal',
  pace: { start_per_day: 10, step_per_week: 5, cap: 30, min_per_day: 2, indexed_share_to_grow: 0.5, index_window_days: 14 },
  menu_pages_need_approval: false,
  health_gate: 'none',
  protected_paths: [],
  shares_audience_with: [],
  local: null,
  ledger_dir: 'data/search-loop',
  llm: { routing_file: null },
  analytics: { ai_referrals: 'none', ai_bot_hits: 'none' },
  conversions: { source: 'none' },
  related: { max_pages_per_new_page: 2, scan_dirs: ['.'], skip_dirs: [] },
  find: { gsc_position_min: 8, gsc_position_max: 30, max_autocomplete_calls: 80, max_targets: 200 },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

export function checkConfig(c) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  if (!c || typeof c !== 'object') return ['config is not an object'];
  need(c.schema === CONFIG_SCHEMA, `schema must be "${CONFIG_SCHEMA}"`);
  need(typeof c.site === 'string' && c.site.length > 2, 'site (a short id, e.g. the host) is required');
  need(/^https:\/\/[^/]+$/.test(c.base_url || ''), 'base_url must be https://host with no trailing slash');
  need(typeof c.site_name === 'string' && c.site_name.length > 1, 'site_name (the brand every title names) is required');
  need(typeof c.audience === 'string' && c.audience.length > 5, 'audience is required');
  need(typeof c.voice === 'string' && c.voice.length > 5, 'voice is required');
  need(Array.isArray(c.topics) && c.topics.length > 0, 'topics: at least one topic seed');
  need(c.action && typeof c.action.label === 'string' && typeof c.action.url === 'string', 'action.label and action.url (the site\'s one action) are required');
  need(Array.isArray(c.allowed_link_targets) && c.allowed_link_targets.length > 0, 'allowed_link_targets: at least one origin');
  need(['normal', 'slow', 'off'].includes(c.mode ?? 'normal'), 'mode must be normal | slow | off');
  need(HEALTH_GATES.includes(c.health_gate ?? 'none'), `health_gate must be ${HEALTH_GATES.join(' | ')}`);
  need(typeof (c.menu_pages_need_approval ?? false) === 'boolean', 'menu_pages_need_approval must be true or false');
  need(Array.isArray(c.protected_paths ?? []), 'protected_paths must be a list');
  const o = c.output || {};
  need(typeof o.dir === 'string' && o.dir && !o.dir.startsWith('/') && !o.dir.includes('..'), 'output.dir: a relative directory for new pages');
  need(PAGE_FORMATS.includes(o.format), `output.format must be ${PAGE_FORMATS.join(' | ')}`);
  need(typeof o.url_prefix === 'string' && o.url_prefix.startsWith('/') && o.url_prefix.endsWith('/'), 'output.url_prefix like "/questions/"');
  const pace = { ...DEFAULTS.pace, ...(c.pace || {}) };
  need(pace.cap <= 30 && pace.start_per_day <= pace.cap && pace.start_per_day >= 1, 'pace: 1 <= start_per_day <= cap <= 30');
  if (c.action?.url && c.allowed_link_targets) {
    const abs = c.action.url.startsWith('/') ? (c.base_url || '') + c.action.url : c.action.url;
    need(c.allowed_link_targets.some((t) => abs.startsWith(t)), 'action.url must sit under one of allowed_link_targets');
  }
  for (const s of c.shares_audience_with || []) need(s && (s.ledger_url || s.ledger_path), 'shares_audience_with entries need ledger_url or ledger_path');
  if (c.local) need(typeof c.local.city === 'string', 'local.city is required when local is set');
  if (c.indexnow) need(typeof c.indexnow.key === 'string' && c.indexnow.key.length >= 8, 'indexnow.key must be the key in the site\'s key file');
  const lowered = [...(c.protected_paths || [])].map(String);
  if (o.dir) need(!lowered.some((pp) => pp === o.dir || o.dir.startsWith(pp + '/')), 'output.dir sits inside a protected path');
  return p;
}

export function loadConfig(file, root = process.cwd()) {
  const full = path.resolve(root, file);
  if (!fs.existsSync(full)) return { problems: [`config not found: ${file}`] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { return { problems: [`config is not valid JSON: ${e.message}`] }; }
  const problems = checkConfig(raw);
  const cfg = merge(DEFAULTS, raw);
  cfg.pace = { ...DEFAULTS.pace, ...(raw.pace || {}) };
  cfg.root = root;
  cfg.ledger_dir = raw.ledger_dir || DEFAULTS.ledger_dir;
  return { cfg, problems };
}

export function isProtected(cfg, rel) {
  const r = String(rel).replace(/^\/+/, '');
  return (cfg.protected_paths || []).some((p) => {
    const pp = String(p).replace(/^\/+/, '');
    return r === pp || r.startsWith(pp.endsWith('/') ? pp : pp + '/');
  });
}
