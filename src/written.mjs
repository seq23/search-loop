// Which site files this run wrote, rewrote or removed (v1.17.2). The caller workflow runs the
// site's finishing step (post_build_command: header, styles, sitemap) when this is above 0, so a
// run that only strengthens, refreshes, reshapes, undoes or merges live pages gets it too. Before
// this the step ran only when a NEW page was published, and porchandparty901.com shipped three
// strengthened question pages with no header or styles (27 Nov 2026, fixed by hand in p-n-p #239).
//
// Read from git, not counted at each write: the engine edits site files in many places (new
// pages, related links in other pages, strengthen, refresh, reshape, undo, merge, redirect lists),
// and whatever the commit step will push is exactly what the site's build must fold in. A
// snapshot is the whole working tree written to a throwaway index (the real index is never
// touched), so a file already changed before the run still counts when the run changes it again.
// The run's own ledger, report and log are left out. A snapshot that cannot be read gives null
// ("could not tell"), and the workflow then runs the finishing step anyway.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function treeSnapshot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return { ok: false, reason: `${root} is not a git checkout` };
  const realIndex = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-index-'));
  const index = path.join(dir, 'index');
  try {
    // A copy of the real index keeps git's file-stat cache, so only changed files are hashed.
    if (realIndex && fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    if (git(top, ['add', '-A', '--', '.'], env) === null) return { ok: false, reason: 'git add into a throwaway index failed' };
    const tree = git(top, ['write-tree'], env)?.trim();
    return tree ? { ok: true, top, tree } : { ok: false, reason: 'git write-tree failed' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Compared as real paths: git prints the top level with symlinks resolved (macOS /var -> /private/var).
function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return abs; } }
}

// files: paths (relative to the repo top) the run changed, minus `ignore` (absolute paths of the
// run's own ledger, report and log). count is null when either snapshot could not be read.
export function pagesWritten(before, after, ignore = []) {
  if (!before?.ok || !after?.ok) return { count: null, files: [], reason: (!before?.ok ? before?.reason : after?.reason) || 'no snapshot' };
  const out = git(before.top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', before.tree, after.tree]);
  if (out === null) return { count: null, files: [], reason: 'git diff-tree failed' };
  const skip = ignore.map(real);
  const files = out.split('\0').filter(Boolean).filter((f) => {
    const abs = path.join(before.top, f);
    return !skip.some((s) => abs === s || abs.startsWith(s + path.sep));
  });
  return { count: files.length, files };
}
