#!/usr/bin/env node
// search-loop run      --config search-loop.config.json [--stage auto|find|build|check|report] [--global-mode normal|slow|off] [--report-out path]
// search-loop validate-config --config search-loop.config.json
// search-loop --self-test
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { resolveMode, rulesFor } from '../src/mode.mjs';
import { find } from '../src/find.mjs';
import { build } from '../src/build.mjs';
import { check } from '../src/check.mjs';
import { buildReport, checkReport } from '../src/report.mjs';
import { currentCap, impressionWindows, nextCap } from '../src/cap.mjs';
import { perDayLimit } from '../src/build.mjs';
import { ledger } from '../src/ledger.mjs';
import { NamedStop, EXIT, isoWeek, writeJson, startClock, progress, runClock } from '../src/util.mjs';
import { selfTest } from '../src/self-test.mjs';
import { draftSlot } from '../src/slot.mjs';
import { resetLanes, noFreeModelStreak } from '../src/llm.mjs';
import crypto from 'node:crypto';

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}

export const staggerMinutes = (site) => parseInt(crypto.createHash('sha256').update(String(site)).digest('hex').slice(0, 8), 16) % 40;

export async function run(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const { cfg, problems } = loadConfig(opts.config || 'search-loop.config.json', root);
  if (problems.length) throw new NamedStop('CONFIG_INVALID', `${opts.config || 'search-loop.config.json'}: ${problems.join('; ')}`, EXIT.PROBLEMS);
  const now = opts.now || new Date();
  const notes = [];
  resetLanes();
  // Stagger: every site shares the same free lanes, so a scheduled run waits a
  // fixed, site-specific 0-39 minutes before it starts (runner minutes are free on
  // public repos). Dispatched runs start at once. cfg.llm.stagger=false turns it off.
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && cfg.llm?.stagger !== false && !opts.noStagger) {
    const mins = staggerMinutes(cfg.site);
    console.log(`stagger: ${cfg.site} waits ${mins} min so sites do not hit the shared free lanes together`);
    await new Promise((r) => setTimeout(r, mins * 60000));
  }
  // Time budget, counted after the stagger. Soft: nothing new starts after it
  // (model call, page, inspection); the run still writes its report and commits.
  // Hard: the watchdog in main() ends a stuck run with NAMED STOP [RUN_HUNG].
  startClock({ softMinutes: opts.softMinutes ?? Number(process.env.SEARCH_LOOP_SOFT_MINUTES || 35) });
  if (opts.onClockStart) opts.onClockStart();
  progress('mode', 'reading the global switch');
  const m = await resolveMode({ globalMode: opts['global-mode'], siteMode: cfg.mode, fetchImpl: opts.fetchImpl, now });
  notes.push(...m.notes);
  let mode = m.mode;
  const stage = opts.stage || 'auto';
  const L = ledger(cfg);
  const did = { find: null, build: null, check: null };

  // FIND weekly (never in off).
  const t = L.read('targets', null);
  // BUILD with no target list (fresh checkout, a replay after main moved) finds first.
  const wantFind = stage === 'find' || (['auto', 'build'].includes(stage) && rulesFor(mode).find === 'weekly' && (!t || (stage === 'auto' && t.week !== isoWeek(now))));
  if (wantFind && rulesFor(mode).find !== 'never') {
    progress('find', 'start');
    did.find = await find(cfg, { fetchImpl: opts.fetchImpl, now, chat: opts.chat });
    for (const [k, v] of Object.entries(did.find.sources)) if (String(v).startsWith('not read')) notes.push(`FIND ${k}: ${v}`);
  } else if (stage === 'find') notes.push(`FIND skipped: mode=${mode}`);

  // CAP weekly, before BUILD: the per-site cap moves only with Google impressions.
  if ((stage === 'auto' || stage === 'build') && rulesFor(mode).build) {
    progress('cap', 'weekly cap check');
    const cur = currentCap(cfg, L, L.pages());
    const nc = cur.last_eval_week === isoWeek(now) ? { cap: cur, evaluated: false } : nextCap(cfg, cur, await impressionWindows(cfg, { now, fetchImpl: opts.fetchImpl }), now);
    if (nc.evaluated) {
      L.write('cap', nc.cap);
      notes.push(nc.held ? `NAMED NOTE [CAP_HELD_NO_DATA] cap ${nc.reason}` : `cap: ${nc.reason}`);
    } else if (!L.read('cap', null)) L.write('cap', cur);
  }

  // BUILD daily.
  if (stage === 'auto' || stage === 'build') {
    progress('build', 'start');
    did.build = await build(cfg, { mode, rules: rulesFor(mode), now, fetchImpl: opts.fetchImpl, chat: opts.chat, notes });
    if (did.build.mode && did.build.mode !== mode) mode = did.build.mode; // free route rate-limited -> slow for today
  }
  // CHECK + REPAIR (daily; weekly in slow; still runs in off).
  if (stage === 'auto' || stage === 'check') progress('check', 'start');
  if (stage === 'auto' || stage === 'check') did.check = await check(cfg, { rules: rulesFor(mode), mode, now, fetchImpl: opts.fetchImpl, chat: opts.chat, notes });

  // NO_FREE_MODEL: a run where every free lane was out and nothing was
  // published is a NAMED NOTE (job summary + weekly report), exit 0: the
  // searches stay queued and the next scheduled run retries them. Her rule:
  // "a stop the next scheduled run retries is a note, not a red main". The
  // streak (runs in a row, since when) is kept in runs.json and named in the
  // note so a lasting outage is visible; any run whose lanes answer ends it.
  const lanesOut = Boolean(did.build?.lanes_out && !did.build.published);
  if (did.build) {
    const runsLedger = L.read('runs', { last_check: null, history: [] });
    const streak = noFreeModelStreak(runsLedger.no_free_model, { out: lanesOut, now });
    if (streak) runsLedger.no_free_model = streak; else delete runsLedger.no_free_model;
    L.write('runs', runsLedger);
    if (lanesOut) {
      notes.push(`NAMED NOTE [NO_FREE_MODEL] every free model lane is out; 0 of ${did.build.quota} page(s) published, the searches stay queued for the next run (run ${streak.runs} in a row since ${streak.since}) — ${did.build.lanes_out}`);
    }
  }
  progress('report', 'writing');
  const rules = rulesFor(mode);
  const effectivePace = perDayLimit(cfg, rules);
  const nothing = !did.find && !(did.build?.published) && !(did.build?.attempted) && !(did.build?.redirected) && !(did.build?.held) && !(did.check?.checked) && !(did.check?.measured) && !(did.check?.indexnow) && !did.check?.skipped;
  const report = buildReport(cfg, { mode, effectivePace, notes, stopped: Boolean(did.build?.stopped), now, check: did.check || {} });
  const rp = checkReport(report);
  if (rp.length) throw new NamedStop('REPORT_SHAPE', rp.join('; '), EXIT.PROBLEMS);
  const out = path.resolve(root, opts['report-out'] || path.join(cfg.ledger_dir, 'search-loop-week.json'));
  writeJson(out, report);
  const census = `search-loop ${cfg.site}: mode=${mode} find=${did.find ? `${did.find.targets} targets` : 'skipped'} published=${did.build?.published ?? 0}/${did.build?.quota ?? 0} held_by_cap=${did.build?.held ?? 0} redirected=${did.build?.redirected ?? 0} dropped=${did.build?.dropped ?? 0} related_links=${did.build?.related_links ?? 0} checked=${did.check?.checked ?? 0} measured=${did.check?.measured ?? 0} wins=${did.check?.wins ?? 0} strengthened=${did.check?.strengthened ?? 0} undone=${did.check?.undone ?? 0} merged=${did.check?.merged ?? 0} indexnow=${did.check?.indexnow ?? 0} report=${path.relative(root, out)}`;
  return { report, census, nothing, mode, did, out, root, cfg };
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o['self-test']) { const r = await selfTest(); console.log(r); return; }
  const cmd = o._[0] || 'run';
  if (cmd === 'validate-config') {
    const { problems } = loadConfig(o.config || 'search-loop.config.json', path.resolve(o.root || process.cwd()));
    if (problems.length) throw new NamedStop('CONFIG_INVALID', problems.join('; '), EXIT.PROBLEMS);
    console.log('config OK');
    return;
  }
  if (cmd === 'draft-slot') {
    // v1.5.0: the material for one calendar slot, as JSON; never published, no ledger.
    const root = path.resolve(o.root || process.cwd());
    const { cfg, problems } = loadConfig(o.config || 'search-loop.config.json', root);
    if (problems.length) throw new NamedStop('CONFIG_INVALID', problems.join('; '), EXIT.PROBLEMS);
    if (!o.slot || !o.out) throw new NamedStop('SLOT_INVALID', 'draft-slot needs --slot <slot.json> and --out <draft.json>', EXIT.PROBLEMS);
    const r = await draftSlot(cfg, JSON.parse(fs.readFileSync(path.resolve(root, o.slot), 'utf8')));
    writeJson(path.resolve(root, o.out), r);
    if (!r.ok) throw new NamedStop(r.stop, r.reason, r.stop === 'FREE_MODEL_KEY_MISSING' ? EXIT.CREDENTIAL : EXIT.PROBLEMS);
    console.log(`draft-slot: ${r.words} words by ${r.model} in ${r.attempts} attempt(s) -> ${o.out}`);
    return;
  }
  if (cmd !== 'run') throw new NamedStop('UNKNOWN_COMMAND', `"${cmd}" — use run, draft-slot, validate-config or --self-test`, EXIT.PROBLEMS);
  // Hard ceiling: a run that is still going this long after its clock started is
  // stuck somewhere no timeout covers; end it loudly with the stage it is in.
  const hardMin = Number(process.env.SEARCH_LOOP_HARD_MINUTES || 55);
  const r = await run({ ...o, onClockStart: () => setTimeout(() => {
    console.error(`NAMED STOP [RUN_HUNG] still running ${hardMin} min after start; stalled in stage "${runClock.stage}". Nothing from this run is committed; the next run retries.`);
    process.exit(EXIT.INCOMPLETE);
  }, hardMin * 60000).unref() });
  for (const n of r.report.notes) console.log(`note: ${n}`);
  console.log(r.census);
  if (o['github-output'] && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report=${r.out}\nmode=${r.mode}\npublished=${r.did.build?.published ?? 0}\npages_dir=${path.resolve(r.root, r.cfg.output.dir)}\nledger_dir=${path.resolve(r.root, r.cfg.ledger_dir)}\n`);
  if (r.nothing && r.mode !== 'off') throw new NamedStop('NOTHING_DONE', 'no search was found, no page built and no page checked this run; the report above says which source was not read', EXIT.NOTHING);
  const keyStop = r.report.notes.find((n) => /NAMED STOP \[FREE_MODEL_KEY_(MISSING|REFUSED)\]/.test(n));
  if (keyStop && !r.did.check?.checked && !r.did.find) throw new NamedStop('FREE_MODEL_KEY', keyStop, EXIT.CREDENTIAL);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('search-loop.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(e.code && Number.isInteger(e.code) ? e.code : 1); });
}
