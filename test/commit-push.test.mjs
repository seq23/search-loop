// The push step on a site whose main moved while the loop ran (every adopting
// site has other jobs committing to main): it must land, merge the ledger, and
// still stop with PUSH_CONFLICT on a real conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitPush, git } from '../bin/commit-push.mjs';
import { mergeJson } from '../src/merge.mjs';

function sh(cwd, ...a) { const r = git(cwd, ...a); assert.ok(r.ok, `git ${a.join(' ')}: ${r.err}`); return r.out; }
function w(root, rel, s) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); }
const j = (o) => JSON.stringify(o, null, 2) + '\n';

// A bare "GitHub" remote, the runner's checkout (run) and another job's checkout (other).
function repos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-push-'));
  const remote = path.join(dir, 'remote.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const clone = (name) => {
    const p = path.join(dir, name);
    sh(dir, 'clone', '-q', remote, p);
    sh(p, 'config', 'user.name', 't'); sh(p, 'config', 'user.email', 't@example.com');
    sh(p, 'checkout', '-q', '-B', 'main');
    return p;
  };
  const seed = clone('seed');
  w(seed, 'index.html', '<h1>home</h1>\n');
  w(seed, 'questions/a/index.html', '<h1>a</h1>\n');
  w(seed, 'data/search-loop/pages.json', j({ schema: 'search-loop-pages-v1', pages: [{ slug: 'a', status: 'live' }] }));
  w(seed, 'data/search-loop/runs.json', j({ schema: 'search-loop-runs-v1', runs: [{ at: '2026-11-01T00:00:00Z', published: 1 }] }));
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'seed'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { remote, run: clone('run'), other: clone('other') };
}
const quiet = { log() {}, warn() {} };
const remoteFile = (remote, rel) => git(remote, 'show', `main:${rel}`).out;

test('commit-push: main moved by another job -> rebases and lands both', async () => {
  const { remote, run, other } = repos();
  w(run, 'questions/b/index.html', '<h1>b</h1>\n');
  w(other, 'index.html', '<h1>home v2</h1>\n');
  sh(other, 'commit', '-qam', 'other job'); sh(other, 'push', '-q', 'origin', 'HEAD:main');
  const code = await commitPush({ cwd: run, branch: 'main', message: 'search loop', jitterMs: 0, ...quiet });
  assert.equal(code, 0);
  assert.equal(remoteFile(remote, 'index.html'), '<h1>home v2</h1>');
  assert.equal(remoteFile(remote, 'questions/b/index.html'), '<h1>b</h1>');
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main').out, /search loop/);
});

test('commit-push: two runs wrote the ledger -> ledger merges, nothing lost', async () => {
  const { remote, run, other } = repos();
  const pages = (extra) => j({ schema: 'search-loop-pages-v1', pages: [{ slug: 'a', status: 'live' }, extra] });
  const runs = (extra) => j({ schema: 'search-loop-runs-v1', runs: [{ at: '2026-11-01T00:00:00Z', published: 1 }, extra] });
  w(other, 'questions/c/index.html', '<h1>c</h1>\n');
  w(other, 'data/search-loop/pages.json', pages({ slug: 'c', status: 'live' }));
  w(other, 'data/search-loop/runs.json', runs({ at: '2026-11-02T11:00:00Z', published: 1 }));
  sh(other, 'add', '-A'); sh(other, 'commit', '-qm', 'earlier loop run'); sh(other, 'push', '-q', 'origin', 'HEAD:main');
  w(run, 'questions/b/index.html', '<h1>b</h1>\n');
  w(run, 'data/search-loop/pages.json', pages({ slug: 'b', status: 'live' }));
  w(run, 'data/search-loop/runs.json', runs({ at: '2026-11-02T12:00:00Z', published: 1 }));
  const code = await commitPush({ cwd: run, branch: 'main', message: 'search loop', ledgerDir: path.join(run, 'data/search-loop'), jitterMs: 0, ...quiet });
  assert.equal(code, 0);
  const book = JSON.parse(remoteFile(remote, 'data/search-loop/pages.json'));
  assert.deepEqual(book.pages.map((p) => p.slug).sort(), ['a', 'b', 'c']);
  const r = JSON.parse(remoteFile(remote, 'data/search-loop/runs.json'));
  assert.equal(r.runs.length, 3);
  assert.equal(remoteFile(remote, 'questions/c/index.html'), '<h1>c</h1>');
  assert.equal(remoteFile(remote, 'questions/b/index.html'), '<h1>b</h1>');
});

test('commit-push: a real conflict outside the ledger -> NAMED STOP [PUSH_CONFLICT], exit 9, main untouched', async () => {
  const { remote, run, other } = repos();
  w(other, 'questions/a/index.html', '<h1>a edited by hand</h1>\n');
  sh(other, 'commit', '-qam', 'hand edit'); sh(other, 'push', '-q', 'origin', 'HEAD:main');
  const before = git(remote, 'rev-parse', 'main').out;
  w(run, 'questions/a/index.html', '<h1>a strengthened</h1>\n');
  const warned = [];
  const code = await commitPush({ cwd: run, branch: 'main', message: 'search loop', jitterMs: 0, log() {}, warn: (s) => warned.push(s) });
  assert.equal(code, 9);
  assert.match(warned.join('\n'), /NAMED STOP \[PUSH_CONFLICT\].*questions\/a\/index\.html/);
  assert.equal(git(remote, 'rev-parse', 'main').out, before);
  assert.equal(git(run, 'status', '--porcelain').out, '', 'the rebase was aborted cleanly');
});

test('commit-push: push refused every time -> NAMED STOP [PUSH_FAILED], exit 9', async () => {
  const { run } = repos();
  sh(run, 'remote', 'set-url', '--push', 'origin', path.join(os.tmpdir(), 'no-such-remote.git'));
  w(run, 'questions/b/index.html', '<h1>b</h1>\n');
  const warned = [];
  const code = await commitPush({ cwd: run, branch: 'main', message: 'search loop', attempts: 3, jitterMs: 0, log() {}, warn: (s) => warned.push(s) });
  assert.equal(code, 9);
  assert.match(warned.join('\n'), /NAMED STOP \[PUSH_FAILED\] 3 push attempts failed/);
});

test('commit-push: nothing changed -> exit 0, no commit', async () => {
  const { remote, run } = repos();
  const before = git(remote, 'rev-parse', 'main').out;
  assert.equal(await commitPush({ cwd: run, branch: 'main', message: 'x', jitterMs: 0, ...quiet }), 0);
  assert.equal(git(remote, 'rev-parse', 'main').out, before);
});

test('mergeJson: keyed records union, mine wins a scalar both changed, deletions hold', () => {
  const base = { generated_at: 't0', pages: [{ slug: 'a', n: 1 }, { slug: 'gone', n: 0 }] };
  const theirs = { generated_at: 't1', pages: [{ slug: 'a', n: 1 }, { slug: 'c', n: 3 }] };
  const mine = { generated_at: 't2', pages: [{ slug: 'a', n: 2 }, { slug: 'gone', n: 0 }, { slug: 'b', n: 2 }] };
  assert.deepEqual(mergeJson(base, theirs, mine), { generated_at: 't2', pages: [{ slug: 'a', n: 2 }, { slug: 'c', n: 3 }, { slug: 'b', n: 2 }] });
});
