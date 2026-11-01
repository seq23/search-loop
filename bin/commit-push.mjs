#!/usr/bin/env node
// Commit this run's pages and ledger and push them to the default branch.
// Every adopting site has other jobs committing to main, so a rejected push is
// normal: wait a random moment, fetch, rebase onto the new tip and try again.
// A rebase conflict inside the engine's own ledger is merged (src/merge.mjs);
// a conflict anywhere else is a real one and ends with NAMED STOP [PUSH_CONFLICT].
//
// usage: commit-push.mjs --branch main --message "..." [--ledger-dir data/search-loop]
//        [--attempts 5] [--jitter-ms 15000]      exit 0 pushed/nothing to commit, 9 not pushed
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mergeJson } from '../src/merge.mjs';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
  return o;
}

export function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve every conflicted path of the rebase in progress, or return the paths that are not ours to merge.
function resolveLedgerConflicts(cwd, ledgerDir) {
  const conflicted = git(cwd, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
  if (!conflicted.length) return { foreign: [], merged: [] };
  const prefix = ledgerDir.replace(/\/+$/, '') + '/';
  const foreign = conflicted.filter((f) => !f.startsWith(prefix));
  if (foreign.length) return { foreign, merged: [] };
  for (const f of conflicted) {
    const stage = (n) => { const r = git(cwd, 'show', `:${n}:${f}`); return r.ok ? r.out : undefined; };
    // In a rebase, stage 2 is the moved default branch, stage 3 is this run's commit.
    const theirs = stage(2), mine = stage(3), base = stage(1);
    let text;
    if (f.endsWith('.json') && theirs !== undefined && mine !== undefined) {
      try {
        const parse = (s) => (s === undefined ? undefined : JSON.parse(s));
        text = JSON.stringify(mergeJson(parse(base), parse(theirs), parse(mine)), null, 2) + '\n';
      } catch { text = undefined; }
    }
    if (text === undefined) {
      if (mine === undefined) { git(cwd, 'rm', '-q', '--', f); continue; }
      text = mine + '\n';
    }
    fs.writeFileSync(path.join(cwd, f), text);
    git(cwd, 'add', '--', f);
  }
  return { foreign: [], merged: conflicted };
}

export async function commitPush({ cwd = process.cwd(), branch, message, ledgerDir = 'data/search-loop', attempts = 5, jitterMs = 15000, log = console.log, warn = console.error } = {}) {
  if (!branch) { warn('NAMED STOP [PUSH_FAILED] no default branch given to commit-push'); return 9; }
  const root = git(cwd, 'rev-parse', '--show-toplevel').out || cwd;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.isAbsolute(ledgerDir) ? path.relative(real(root), real(ledgerDir)) : ledgerDir;
  git(root, 'add', '-A');
  if (git(root, 'diff', '--cached', '--quiet').ok) { log('search-loop: nothing to commit'); return 0; }
  const c = git(root, 'commit', '-q', '-m', message || 'search loop: daily pages, checks and ledger');
  if (!c.ok) { warn(`NAMED STOP [PUSH_FAILED] commit failed: ${c.err.split('\n')[0]}`); return 9; }
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    const p = git(root, 'push', 'origin', `HEAD:${branch}`);
    if (p.ok) { log(`search-loop: pushed ${git(root, 'rev-parse', '--short', 'HEAD').out} to ${branch} (attempt ${i}/${attempts})`); return 0; }
    last = p.err.split('\n').find((l) => /rejected|error|fatal/i.test(l)) || p.err.split('\n')[0] || 'push refused';
    if (i === attempts) break;
    const wait = Math.floor(Math.random() * jitterMs * i);
    log(`search-loop: push attempt ${i}/${attempts} refused (${last.trim()}); rebasing onto origin/${branch} after ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    const f = git(root, 'fetch', '-q', 'origin', branch);
    if (!f.ok) { last = `fetch failed: ${f.err.split('\n')[0]}`; continue; }
    let r = git(root, 'rebase', '-q', 'FETCH_HEAD');
    let merged = [];
    while (!r.ok) {
      const res = resolveLedgerConflicts(root, rel);
      if (res.foreign.length || !res.merged.length) {
        git(root, 'rebase', '--abort');
        const why = res.foreign.length ? `conflict outside the ledger: ${res.foreign.join(', ')}` : r.err.split('\n')[0];
        warn(`NAMED STOP [PUSH_CONFLICT] rebase onto ${branch} failed (${why}); nothing pushed, the next run redoes today's work`);
        return 9;
      }
      merged = merged.concat(res.merged);
      r = git(root, 'rebase', '--continue');
    }
    if (merged.length) log(`search-loop: merged ledger file(s) after rebase: ${[...new Set(merged)].join(', ')}`);
  }
  warn(`NAMED STOP [PUSH_FAILED] ${attempts} push attempts failed (last: ${last.trim()}); nothing pushed, the next run redoes today's work`);
  return 9;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('commit-push.mjs')) {
  const o = args(process.argv.slice(2));
  const code = await commitPush({
    branch: o.branch,
    message: o.message,
    ledgerDir: o['ledger-dir'] || 'data/search-loop',
    attempts: Number(o.attempts || 5),
    jitterMs: Number(process.env.SEARCH_LOOP_PUSH_JITTER_MS ?? o['jitter-ms'] ?? 15000),
  });
  process.exit(code);
}
