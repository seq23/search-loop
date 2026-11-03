// REPORT: search-loop-week-v1, uploaded as the Actions artifact
// "search-loop-week" on every run. Boss OS reads this schema — the field names
// are a contract; validators/validate.mjs pins them.
import { ledger } from './ledger.mjs';
import { centralDate, daysBetween, isoWeek } from './util.mjs';
import { OFF_SENTENCE } from './mode.mjs';
import { currentCap, heldThisWeek, liveEnginePages } from './cap.mjs';

export const REPORT_SCHEMA = 'search-loop-week-v1';
export const REPORT_FIELDS = ['site', 'generated_at', 'state', 'published', 'indexed', 'pace', 'ai_visitors', 'ai_bot_hits', 'conversions', 'wins', 'undone', 'merged', 'held_by_cap', 'redirected', 'cap', 'notes', 'run_url'];
export const STATES = ['running', 'slow', 'off', 'stopped'];

const within7 = (d, today) => d && daysBetween(d, today) >= 0 && daysBetween(d, today) < 7;

export function sumDaily(daily, key, today) {
  let total = 0; let read = 0; const why = new Set();
  for (const [d, v] of Object.entries(daily?.days || {})) {
    if (!within7(d, today)) continue;
    if (v[key] && typeof v[key].total === 'number') { total += v[key].total; read++; } else if (v[`${key}_not_read`] || v.not_read) why.add(v[`${key}_not_read`] || v.not_read);
  }
  if (!read) return `not read: ${[...why][0] || 'no day this week was collected'}`;
  return total;
}

export function buildReport(cfg, { mode, effectivePace, notes = [], stopped = false, now = new Date(), check = {} } = {}) {
  const L = ledger(cfg);
  const today = centralDate(now);
  const book = L.pages();
  const pages = book.pages || [];
  const daily = L.read('ai_daily', { days: {} });
  const conv = cfg.conversions?.source && cfg.conversions.source !== 'none'
    ? `not read: conversion source "${cfg.conversions.source}" has no free reader in search-loop yet`
    : 'not read: no conversion source configured for this site (form fills / checkouts)';
  const capState = currentCap(cfg, L, book);
  const live = liveEnginePages(book).length;
  const anyInspected = pages.some((p) => p.inspected_at);
  const allNotes = [...notes];
  if (mode === 'off' && !allNotes.includes(OFF_SENTENCE)) allNotes.unshift(OFF_SENTENCE);
  const r = {
    schema: REPORT_SCHEMA,
    week: isoWeek(now),
    site: cfg.site,
    generated_at: now.toISOString(),
    state: stopped ? 'stopped' : mode === 'normal' ? 'running' : mode,
    published: pages.filter((p) => within7(p.published_at, today)).length,
    indexed: anyInspected ? pages.filter((p) => p.indexed && p.status === 'live').length : pages.length ? `not read: ${check.indexNote || 'no page old enough to inspect yet (14 days)'}` : 0,
    pace: effectivePace,
    ai_visitors: sumDaily(daily, 'ai_visitors', today),
    ai_bot_hits: sumDaily(daily, 'ai_bot_hits', today),
    conversions: conv,
    wins: pages.filter((p) => within7(p.winner, today)).length,
    undone: pages.filter((p) => p.strengthen?.verdict?.undone && within7(p.strengthen.verdict.at, today)).length,
    merged: pages.filter((p) => p.status === 'merged' && within7(p.merged?.at, today)).length,
    // v1.3.0 (her ruling, 3 Nov 2026): distinct pages only, under a cap that grows with results.
    held_by_cap: heldThisWeek(capState, now),
    redirected: (book.redirected || []).filter((x) => within7(x.at, today)).map((x) => ({ query: x.query, strengthen: x.url, matched_by: x.matched_by, at: x.at })),
    cap: { max_live_pages: capState.max_live_pages, live, room: Math.max(0, capState.max_live_pages - live), why: capState.reason },
    notes: allNotes,
    run_url: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  };
  return r;
}

export function checkReport(r) {
  const p = [];
  if (!r || r.schema !== REPORT_SCHEMA) p.push(`schema must be ${REPORT_SCHEMA}`);
  for (const f of REPORT_FIELDS) if (!(f in (r || {}))) p.push(`missing field ${f}`);
  if (r && !STATES.includes(r.state)) p.push(`state must be one of ${STATES.join('|')}`);
  for (const f of ['published', 'wins', 'undone', 'merged', 'pace']) if (r && typeof r[f] !== 'number') p.push(`${f} must be a number`);
  for (const f of ['indexed', 'ai_visitors', 'ai_bot_hits', 'conversions']) if (r && !(typeof r[f] === 'number' || (typeof r[f] === 'string' && r[f].startsWith('not read: ')))) p.push(`${f} must be a number or "not read: <reason>"`);
  if (r && !Array.isArray(r.notes)) p.push('notes must be a list');
  if (r && typeof r.held_by_cap !== 'number') p.push('held_by_cap must be a number');
  if (r && (!Array.isArray(r.redirected) || r.redirected.some((x) => !x || typeof x.query !== 'string' || !/^https?:\/\//.test(String(x.strengthen))))) p.push('redirected must be a list of {query, strengthen: <existing URL>}');
  if (r && !(r.cap && Number.isInteger(r.cap.max_live_pages) && typeof r.cap.why === 'string' && r.cap.why.length > 0)) p.push('cap must say max_live_pages and why');
  if (r?.state === 'off' && !(r.notes || []).some((n) => n.includes(OFF_SENTENCE))) p.push(`an off report must say "${OFF_SENTENCE}"`);
  return p;
}
