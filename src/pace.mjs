// Pace: start 10/day, +5 a week while most new pages are indexed within 14
// days, cap 30, halve automatically when indexing falls. Every change logged
// with its reason. Evaluated once per ISO week.
import { isoWeek } from './util.mjs';

export function currentPace(cfg, L) {
  const p = L.read('pace', null);
  if (p && Number.isFinite(p.per_day)) return p;
  return { schema: 'search-loop-pace-v1', per_day: cfg.pace.start_per_day, last_eval_week: null, history: [] };
}

// sample: { measured: n pages old enough, indexed: n of them indexed, source }
export function nextPace(cfg, pace, sample, now = new Date()) {
  const week = isoWeek(now);
  if (pace.last_eval_week === week) return { pace, changed: false, reason: 'already evaluated this week' };
  const { cap, step_per_week: step, min_per_day: min, indexed_share_to_grow: grow } = cfg.pace;
  const from = pace.per_day;
  let to = from;
  let reason;
  if (!sample || sample.measured === 0 || sample.indexed == null) {
    reason = `held at ${from}/day: indexing not read (${sample?.reason || 'no pages old enough to measure'})`;
  } else {
    const share = sample.indexed / sample.measured;
    const pct = Math.round(share * 100);
    if (share > grow) { to = Math.min(cap, from + step); reason = `${sample.indexed}/${sample.measured} (${pct}%) of pages ${cfg.pace.index_window_days}+ days old are indexed (${sample.source}) — ${to === from ? `held at the cap ${cap}` : `up ${step}`}`; }
    else { to = Math.max(min, Math.floor(from / 2)); reason = `only ${sample.indexed}/${sample.measured} (${pct}%) of pages ${cfg.pace.index_window_days}+ days old are indexed (${sample.source}) — halved`; }
  }
  const out = { ...pace, per_day: to, last_eval_week: week, history: [...(pace.history || []), { at: now.toISOString(), week, from, to, reason }].slice(-104) };
  return { pace: out, changed: to !== from, reason };
}
