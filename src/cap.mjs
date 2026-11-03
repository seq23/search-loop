// OUTCOME-GATED PER-SITE CAP (her ruling, 3 Nov 2026; replaces the old fixed
// pace of 10/day, +5/week, cap 30). The engine keeps at most
// cap.max_live_pages live pages per site. New pages publish only while the
// site is under it. Once a week the cap moves with results:
//   - Google impressions for the last 28 days beat the 28 before -> +grow_share (10%)
//   - they dropped -> back by grow_share (never under min_pages)
//   - equal, or Search Console not readable -> held (no growth), with a note
// Starting value: cap.max_live_pages when the site sets it, otherwise the
// site's distinct live engine pages (near-twins count once), at least
// start_pages (20). cap.max_per_day (10) is a run guard for the shared free
// model lanes, not a pace: it never grows.
import { isoWeek, centralDate, daysBetween } from './util.mjs';
import { searchAnalytics, dateDaysAgo } from './gsc.mjs';
import { distinctCount } from './distinct.mjs';

import { CAP_DEFAULTS } from './defaults.mjs';
export { CAP_DEFAULTS };
export const WINDOW_DAYS = 28;
export const GSC_LAG_DAYS = 3;

export const liveEnginePages = (book) => (book?.pages || []).filter((p) => p.status === 'live');

export function currentCap(cfg, L, book) {
  const c = { ...CAP_DEFAULTS, ...(cfg.cap || {}) };
  const saved = L.read('cap', null);
  const fixed = Number.isInteger(c.max_live_pages) ? c.max_live_pages : null;
  if (saved && Number.isInteger(saved.max_live_pages) && saved.config_value === fixed) return saved;
  const live = liveEnginePages(book);
  const distinct = distinctCount(cfg, live);
  const value = fixed ?? Math.max(c.start_pages, distinct);
  const reason = fixed != null
    ? `set from the site config (cap.max_live_pages ${fixed})`
    : `started at ${value}: the site's ${distinct} distinct live engine page(s)${distinct < c.start_pages ? `, raised to the starting floor of ${c.start_pages}` : ''}`;
  return { schema: 'search-loop-cap-v1', max_live_pages: value, config_value: fixed, reason, last_eval_week: null, history: [{ at: new Date().toISOString(), from: null, to: value, reason }], held: {} };
}

// Google impressions, last 28 days vs the 28 before (Search Console lags ~3 days).
export async function impressionWindows(cfg, { now = new Date(), fetchImpl = fetch } = {}) {
  const site = cfg.gsc?.site_url || process.env[cfg.gsc?.site_url_env || 'GSC_SITE_URL'];
  const lastFrom = dateDaysAgo(GSC_LAG_DAYS + WINDOW_DAYS - 1, now);
  const prevFrom = dateDaysAgo(GSC_LAG_DAYS + 2 * WINDOW_DAYS - 1, now);
  const end = dateDaysAgo(GSC_LAG_DAYS, now);
  const r = await searchAnalytics(site, { startDate: prevFrom, endDate: end, dimensions: ['date'], rowLimit: 100 }, { fetchImpl });
  if (!r.ok) return { notRead: `Search Console: ${r.reason}` };
  let last = 0; let prev = 0; let lastDays = 0; let prevDays = 0;
  for (const row of r.rows) {
    const d = String(row.keys?.[0] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < prevFrom || d > end) continue;
    if (d >= lastFrom) { last += row.impressions || 0; lastDays++; } else { prev += row.impressions || 0; prevDays++; }
  }
  if (!lastDays && !prevDays) return { notRead: 'Search Console returned no daily impression rows for the last 56 days' };
  if (!prevDays) return { notRead: `Search Console has no rows for ${prevFrom}..${dateDaysAgo(GSC_LAG_DAYS + WINDOW_DAYS, now)}, so there is nothing to compare the last 28 days with` };
  return { last, prev, lastDays, prevDays, window: { last: [lastFrom, end], prev: [prevFrom, dateDaysAgo(GSC_LAG_DAYS + WINDOW_DAYS, now)] } };
}

// Pure: one weekly decision. w = impressionWindows() result.
export function nextCap(cfg, cap, w, now = new Date()) {
  const c = { ...CAP_DEFAULTS, ...(cfg.cap || {}) };
  const week = isoWeek(now);
  if (cap.last_eval_week === week) return { cap, changed: false, evaluated: false, reason: cap.reason };
  const from = cap.max_live_pages;
  let to = from; let reason; let held = false;
  if (!w || w.notRead) { held = true; reason = `held at ${from}: no Search Console numbers to judge results (${w?.notRead || 'not read'}); the cap never grows without data`; }
  else if (w.last > w.prev) { to = Math.max(from + 1, Math.ceil(from * (1 + c.grow_share) - 1e-9)); reason = `up from ${from} to ${to}: Google impressions ${w.last} in the last 28 days beat ${w.prev} in the 28 before`; }
  else if (w.last < w.prev) { to = Math.max(c.min_pages, Math.floor(from * (1 - c.grow_share) + 1e-9)); reason = to === from ? `held at the floor ${from}: impressions fell (${w.last} vs ${w.prev})` : `down from ${from} to ${to}: Google impressions fell to ${w.last} in the last 28 days from ${w.prev} in the 28 before`; }
  else reason = `held at ${from}: Google impressions flat (${w.last} vs ${w.prev})`;
  const out = { ...cap, max_live_pages: to, reason, last_eval_week: week, ...(w && !w.notRead ? { impressions: { last_28: w.last, prev_28: w.prev } } : {}), history: [...(cap.history || []), { at: now.toISOString(), week, from, to, reason }].slice(-104) };
  return { cap: out, changed: to !== from, evaluated: true, held, reason };
}

export function recordHeld(cap, n, now = new Date()) {
  const today = centralDate(now);
  const held = { ...(cap.held || {}) };
  held[today] = (held[today] || 0) + n;
  for (const d of Object.keys(held)) if (daysBetween(d, today) > 30) delete held[d];
  return { ...cap, held };
}

export function heldThisWeek(cap, now = new Date()) {
  const today = centralDate(now);
  return Object.entries(cap?.held || {}).filter(([d]) => { const n = daysBetween(d, today); return n >= 0 && n < 7; }).reduce((s, [, n]) => s + n, 0);
}
