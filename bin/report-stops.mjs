#!/usr/bin/env node
// REPORT THE RUN'S NAMED STOPS TO OPEN LOOPS (boss-os docs/open-loops.md; loop olp_m6cxdv7ab965hkmg).
// A stop nobody reads in a site's Actions log still gets chased: every `NAMED STOP [CODE] why` the
// run printed becomes one row on Boss OS's Open Loops (one per <repo>#CODE), and every known code the
// run did NOT print is posted cleared, which closes its row the day the stop clears.
// Never fails the run: no BOSS_OPEN_LOOPS_TOKEN → one line, nothing sent; a failed post → one line.
//   node bin/report-stops.mjs --log .search-loop-run.log --repo owner/name [--business spry]
import fs from 'node:fs';
import { reportToOpenLoops } from './open-loops.mjs';

/** Every run-level stop this engine and its workflow can raise. A code here that a run did not print is cleared. */
export const KNOWN = [
  'RUN_HUNG', 'PUSH_FAILED', 'PUSH_CONFLICT', 'NO_TARGETS', 'NOTHING_DONE', 'CONFIG_INVALID',
  'FREE_MODEL_KEY_MISSING', 'REPORT_SHAPE', 'ENGINE_DID_NOT_RUN',
];

/** The stops a run's log names, last word per code wins. Only KNOWN codes, so a stray line never opens a row. Pure. */
export function stopsInLog(text) {
  const found = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /NAMED STOP \[([A-Z][A-Z0-9_]{1,60})\]\s*(.*)$/.exec(line);
    if (m && KNOWN.includes(m[1])) found.set(m[1], { code: m[1], why: m[2].trim().slice(0, 300) || 'no reason printed' });
  }
  return [...found.values()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d = '') => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const repo = arg('--repo', process.env.GITHUB_REPOSITORY ?? '');
  const log = arg('--log', '.search-loop-run.log');
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { console.log(`open loops: not reported (${log} was not written, so this run's stops are unknown)`); process.exit(0); }
  const stops = stopsInLog(text);
  await reportToOpenLoops({
    repo, business: arg('--business', 'spry'),
    finish: 'The Search Loop runs daily on this site and publishes its pages',
    known: KNOWN, stops,
  });
}
