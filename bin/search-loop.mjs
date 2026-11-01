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
import { currentPace } from '../src/pace.mjs';
import { ledger } from '../src/ledger.mjs';
import { NamedStop, EXIT, isoWeek, writeJson } from '../src/util.mjs';
import { selfTest } from '../src/self-test.mjs';

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}

export async function run(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const { cfg, problems } = loadConfig(opts.config || 'search-loop.config.json', root);
  if (problems.length) throw new NamedStop('CONFIG_INVALID', `${opts.config || 'search-loop.config.json'}: ${problems.join('; ')}`, EXIT.PROBLEMS);
  const now = opts.now || new Date();
  const notes = [];
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
    did.find = await find(cfg, { fetchImpl: opts.fetchImpl, now, chat: opts.chat });
    for (const [k, v] of Object.entries(did.find.sources)) if (String(v).startsWith('not read')) notes.push(`FIND ${k}: ${v}`);
  } else if (stage === 'find') notes.push(`FIND skipped: mode=${mode}`);

  // BUILD daily.
  if (stage === 'auto' || stage === 'build') {
    did.build = await build(cfg, { mode, rules: rulesFor(mode), now, fetchImpl: opts.fetchImpl, chat: opts.chat, notes });
    if (did.build.mode && did.build.mode !== mode) mode = did.build.mode; // free route rate-limited -> slow for today
  }
  // CHECK + REPAIR (daily; weekly in slow; still runs in off).
  if (stage === 'auto' || stage === 'check') did.check = await check(cfg, { rules: rulesFor(mode), mode, now, fetchImpl: opts.fetchImpl, chat: opts.chat, notes });

  const pace = currentPace(cfg, L).per_day;
  const rules = rulesFor(mode);
  const effectivePace = !rules.build ? 0 : rules.build_cap == null ? pace : Math.min(pace, rules.build_cap);
  const nothing = !did.find && !(did.build?.published) && !(did.build?.attempted) && !(did.check?.checked) && !(did.check?.indexnow) && !did.check?.skipped;
  const report = buildReport(cfg, { mode, effectivePace, notes, stopped: Boolean(did.build?.stopped), now, check: did.check || {} });
  const rp = checkReport(report);
  if (rp.length) throw new NamedStop('REPORT_SHAPE', rp.join('; '), EXIT.PROBLEMS);
  const out = path.resolve(root, opts['report-out'] || path.join(cfg.ledger_dir, 'search-loop-week.json'));
  writeJson(out, report);
  const census = `search-loop ${cfg.site}: mode=${mode} find=${did.find ? `${did.find.targets} targets` : 'skipped'} published=${did.build?.published ?? 0}/${did.build?.quota ?? 0} dropped=${did.build?.dropped ?? 0} related_links=${did.build?.related_links ?? 0} checked=${did.check?.checked ?? 0} wins=${did.check?.wins ?? 0} strengthened=${did.check?.strengthened ?? 0} undone=${did.check?.undone ?? 0} merged=${did.check?.merged ?? 0} indexnow=${did.check?.indexnow ?? 0} report=${path.relative(root, out)}`;
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
  if (cmd !== 'run') throw new NamedStop('UNKNOWN_COMMAND', `"${cmd}" — use run, validate-config or --self-test`, EXIT.PROBLEMS);
  const r = await run(o);
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
