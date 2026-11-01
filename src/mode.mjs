// The one global throttle. Repository variable SEARCH_LOOP_MODE on
// seq23/search-loop = normal | slow | off, mirrored to control/mode.json by
// .github/workflows/mode-sync.yml so every caller can read it with no token.
// A site config may only LOWER the mode, never raise it. A rate-limited free
// model route lowers the day to slow by itself.
import { fetchText } from './util.mjs';

export const MODES = ['off', 'slow', 'normal'];
export const MODE_URL = 'https://raw.githubusercontent.com/seq23/search-loop/main/control/mode.json';
export const SYNC_STALE_DAYS = 9;

// What each mode lets a run do. One table; stages read it, tests pin it.
export const MODE_RULES = {
  normal: { find: 'weekly', build: true, build_cap: null, check: 'daily', strengthen: true, undo: true, merge: true },
  slow: { find: 'weekly', build: true, build_cap: 3, check: 'weekly', strengthen: false, undo: true, merge: true },
  off: { find: 'never', build: false, build_cap: 0, check: 'daily', strengthen: false, undo: false, merge: false },
};

export const OFF_SENTENCE = 'Search loop is switched off (mode=off)';

export function lowest(...modes) {
  const known = modes.filter((m) => MODES.includes(m));
  if (!known.length) return 'normal';
  return known.sort((a, b) => MODES.indexOf(a) - MODES.indexOf(b))[0];
}

export function parseModeFile(text, now = new Date()) {
  let j;
  try { j = JSON.parse(text); } catch { return { mode: null, note: 'control/mode.json is not JSON' }; }
  const mode = String(j?.mode || '').trim().toLowerCase();
  if (!MODES.includes(mode)) return { mode: null, note: `control/mode.json names unknown mode "${j?.mode}"` };
  const age = j.synced_at ? (now - new Date(j.synced_at)) / 86400000 : Infinity;
  const note = age > SYNC_STALE_DAYS ? `global mode file last synced ${Number.isFinite(age) ? Math.floor(age) + ' days ago' : 'never'}; mode-sync.yml may have stopped` : null;
  return { mode, note };
}

// Resolve the run's mode. Input precedence for the GLOBAL value: an explicit
// value (the reusable workflow passes the synced file it read) > the URL.
// An unreadable global switch fails to SLOW, never to normal: a switch that
// silently fails open is not a switch.
export async function resolveMode({ globalMode, siteMode = 'normal', fetchImpl, now = new Date() } = {}) {
  const notes = [];
  let g = globalMode && MODES.includes(globalMode) ? globalMode : null;
  if (!g) {
    const r = await fetchText(MODE_URL, { fetchImpl, timeoutMs: 10000 });
    if (r.ok) {
      const p = parseModeFile(r.text, now);
      g = p.mode;
      if (p.note) notes.push(`NAMED NOTE [MODE_SYNC_STALE] ${p.note}`);
    }
    if (!g) {
      g = 'slow';
      notes.push(`NAMED NOTE [MODE_UNREAD] the global switch could not be read (${r.status || r.error || 'bad file'}); running slow for safety`);
    }
  }
  const s = MODES.includes(siteMode) ? siteMode : 'normal';
  const mode = lowest(g, s);
  if (s !== 'normal' && MODES.indexOf(s) < MODES.indexOf(g)) notes.push(`site config lowers the mode to ${s}`);
  return { mode, global: g, site: s, notes };
}

export const rulesFor = (mode) => MODE_RULES[mode] || MODE_RULES.slow;
