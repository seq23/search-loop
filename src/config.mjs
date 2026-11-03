// Per-site config: search-loop.config.json in the site repo. One definition of
// what a valid config is; validators/validate.mjs and the CLI both call it.
import fs from 'node:fs';
import path from 'node:path';
import { CAP_DEFAULTS, DISTINCT_DEFAULTS } from './defaults.mjs';

export const CONFIG_SCHEMA = 'search-loop-config-v1';
export const HEALTH_GATES = ['none', 'health', 'dental'];
export const PAGE_FORMATS = ['dir-index', 'html-file'];

export const DEFAULTS = {
  mode: 'normal',
  cap: CAP_DEFAULTS,
  distinct: DISTINCT_DEFAULTS,
  menu_pages_need_approval: false,
  published_pages_frozen: false,
  approval: { new_pages: false, pending_dir: null, approvals_file: null },
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
  need(c.author === undefined || (c.author && typeof c.author.name === 'string' && c.author.name.trim()), 'author: { name, url? } (a real person shown as the byline)');
  need(c.distinct?.near_dup === undefined || (typeof c.distinct.near_dup === 'number' && c.distinct.near_dup > 0 && c.distinct.near_dup <= 0.35), 'distinct.near_dup: above 0, at most 0.35 (stricter than the default only)');
  need(c.local?.substance === undefined || typeof c.local.substance === 'string', 'local.substance: what every local page must carry');
  need(c.reserved_titles === undefined || typeof c.reserved_titles === 'string', 'reserved_titles: a path to a JSON list of [{ route, title }]');
  need(typeof (c.published_pages_frozen ?? false) === 'boolean', 'published_pages_frozen must be true or false');
  const ap = c.approval || {};
  need(typeof (ap.new_pages ?? false) === 'boolean', 'approval.new_pages must be true or false');
  for (const k of ['pending_dir', 'approvals_file']) need(ap[k] == null || (typeof ap[k] === 'string' && ap[k] && !ap[k].startsWith('/') && !ap[k].includes('..')), `approval.${k}: a relative path inside the repo`);
  const o = c.output || {};
  need(typeof o.dir === 'string' && o.dir && !o.dir.startsWith('/') && !o.dir.includes('..'), 'output.dir: a relative directory for new pages');
  need(PAGE_FORMATS.includes(o.format), `output.format must be ${PAGE_FORMATS.join(' | ')}`);
  need(typeof o.url_prefix === 'string' && o.url_prefix.startsWith('/') && o.url_prefix.endsWith('/'), 'output.url_prefix like "/questions/"');
  // `pace` (the old fixed 10/day +5/week) is retired in v1.3.0; an old key is ignored.
  const cap = { ...CAP_DEFAULTS, ...(c.cap || {}) };
  need(cap.max_live_pages === null || (Number.isInteger(cap.max_live_pages) && cap.max_live_pages >= 1), 'cap.max_live_pages: null (start from the site\'s distinct live pages) or a whole number >= 1');
  need(Number.isInteger(cap.max_per_day) && cap.max_per_day >= 1 && cap.max_per_day <= 30, 'cap.max_per_day: 1-30 (a run guard for the shared free lanes)');
  need(typeof cap.grow_share === 'number' && cap.grow_share > 0 && cap.grow_share <= 0.5, 'cap.grow_share: above 0, at most 0.5');
  need(Number.isInteger(cap.min_pages) && cap.min_pages >= 0 && Number.isInteger(cap.start_pages) && cap.start_pages >= cap.min_pages, 'cap: 0 <= min_pages <= start_pages, whole numbers');
  const dist = { ...DISTINCT_DEFAULTS, ...(c.distinct || {}) };
  need([dist.jaccard, dist.same_answer].every((x) => typeof x === 'number' && x > 0 && x <= 1), 'distinct.jaccard and distinct.same_answer: above 0, at most 1');
  need(Number.isInteger(dist.containment_min_words) && dist.containment_min_words >= 2, 'distinct.containment_min_words: a whole number >= 2');
  need(dist.sitemap_files === null || Array.isArray(dist.sitemap_files), 'distinct.sitemap_files: null (every sitemap*.xml at the root) or a list of files');
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
  cfg.cap = { ...CAP_DEFAULTS, ...(raw.cap || {}) };
  cfg.distinct = { ...DISTINCT_DEFAULTS, ...(raw.distinct || {}) };
  cfg.root = root;
  cfg.ledger_dir = raw.ledger_dir || DEFAULTS.ledger_dir;
  return { cfg, problems };
}

// Approval mode (owner ruling, 3 Nov 2026, Horse: "horse owners want to approve
// everything that goes live"). With approval.new_pages true, BUILD writes each
// new page into pending_dir (the owners' queue) and never into the site; a page
// goes live only once its slug is listed under "approved" in approvals_file.
export function approvalOf(cfg) {
  if (cfg?.approval?.new_pages !== true) return null;
  const led = String(cfg.ledger_dir || DEFAULTS.ledger_dir).replace(/\/+$/, '');
  return { pending_dir: cfg.approval.pending_dir || `${led}/pending`, approvals_file: cfg.approval.approvals_file || `${led}/approvals.json` };
}

// Sites whose already-published pages the engine never modifies, redirects,
// merges, unpublishes or undoes (her ruling, 3 Nov 2026: Horse and Hicks).
// Keyed by host so no caller repo changes; a site may also set
// published_pages_frozen: true in its own config. The list always wins.
export const FROZEN_SITES = ['horselegalguide.com', 'hicksconsulting.org'];
export function publishedFrozen(cfg) {
  if (cfg?.published_pages_frozen === true) return true;
  let host = '';
  try { host = new URL(cfg?.base_url || '').host.replace(/^www\./, ''); } catch { /* no base_url */ }
  return FROZEN_SITES.includes(host) || FROZEN_SITES.includes(String(cfg?.site || '').replace(/^www\./, ''));
}

export function isProtected(cfg, rel) {
  const r = String(rel).replace(/^\/+/, '');
  return (cfg.protected_paths || []).some((p) => {
    const pp = String(p).replace(/^\/+/, '');
    return r === pp || r.startsWith(pp.endsWith('/') ? pp : pp + '/');
  });
}
