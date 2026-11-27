// v1.17.2: the site's finishing step (post_build_command: header, styles, sitemap) runs after any
// run that wrote, rewrote or removed a site file, not only after a new page. p-n-p, 27 Nov 2026:
// a run strengthened 3 live question pages, published 0, the step never ran, and the pages went
// live with no header or styles. These tests run the real engine on a git checkout of the fixture
// site, then feed its pages_written / published outputs to the REAL `if:` of the caller workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, githubOutputs } from '../bin/search-loop.mjs';
import { site, fakeFetch, goodChat, distinctChat, NOW } from './harness.mjs';

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commitAll = (root, msg) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', msg); };
function gitSite() {
  const root = site();
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '.search-loop-engine/\n');
  commitAll(root, 'site');
  return root;
}

// The caller workflow's real condition for the finishing step, evaluated for one run's outputs.
// Only the subset the step uses: inputs.*, steps.engine.outputs.*, '...' strings, == != && ||.
const WORKFLOW = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/search-loop.yml'), 'utf8');
const stepIf = (() => {
  const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Site finishing step'), WORKFLOW.indexOf('- name: Commit and push'));
  const m = /^\s+if:\s*(.*)$/m.exec(step);
  assert.ok(m, 'the finishing step has an if: line');
  return m[1];
})();
function finishingStepRuns({ postBuild = 'bash .github/scripts/search_loop_post_build.sh', outputs }) {
  const js = stepIf
    .replace(/\binputs\.post_build_command\b/g, () => JSON.stringify(postBuild))
    .replace(/\bsteps\.engine\.outputs\.([a-z_]+)\b/g, (_, k) => JSON.stringify(outputs[k] === undefined ? '' : String(outputs[k])));
  assert.match(js, /^[\s"'\w./=!&|-]*$/, `only literals left in: ${js}`);
  return Boolean(new Function(`return (${js});`)());
}
// What the engine writes to GITHUB_OUTPUT (the same function main() uses).
const outputsOf = (r) => githubOutputs(r);

test('rewrite-only run (strengthen, 0 new pages): pages_written counts the rewritten page and the finishing step runs', async () => {
  const root = gitSite();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  commitAll(root, 'day 1');
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  // 4 weeks later at position 14: CHECK strengthens; stage check, so nothing new is published.
  const r = await run({ root, now: new Date('2026-11-30T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 14 })) }), chat: goodChat() });
  assert.ok(r.did.check.strengthened >= 1, `strengthened: ${r.report.notes.join(' | ')}`);
  assert.equal(r.did.build, null, 'no BUILD this run');
  const strengthened = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages.filter((p) => p.strengthen?.before_hash).map((p) => p.rel);
  for (const rel of strengthened) assert.ok(r.written.files.includes(rel), `${rel} is in pages_written (${r.written.files.join(', ')})`);
  assert.ok(r.written.files.every((f) => !f.startsWith('data/search-loop/')), 'the ledger, snapshots and drafts are not site pages');
  assert.equal(r.written.count, r.written.files.length);
  assert.match(r.census, new RegExp(`pages_written=${r.written.count}\\b`));
  assert.equal(outputsOf(r).published, 0);
  assert.equal(outputsOf(r).pages_written, r.written.count);
  assert.equal(finishingStepRuns({ outputs: outputsOf(r) }), true, 'a rewrite-only run runs the site finishing step');
});

test('a run that writes no site file: pages_written=0 and the finishing step does not run', async () => {
  const root = gitSite();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  commitAll(root, 'day 1');
  // The next day, CHECK only: nothing is due a checkpoint, so only the ledger may change.
  const r = await run({ root, now: new Date('2026-11-07T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.equal(r.did.check.strengthened || 0, 0);
  assert.equal(r.written.count, 0, `nothing written, saw ${r.written.files.join(', ')}`);
  assert.equal(finishingStepRuns({ outputs: outputsOf(r) }), false);
});

test('new-only and new + rewrite runs count every site file written; the finishing step runs', async () => {
  const root = gitSite();
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.ok(r.did.build.published > 0);
  const live = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages.filter((p) => p.status === 'live').map((p) => p.rel);
  for (const rel of live) assert.ok(r.written.files.includes(rel), `new page ${rel} counted`);
  assert.ok(r.written.count >= r.did.build.published);
  assert.equal(finishingStepRuns({ outputs: outputsOf(r) }), true);
  commitAll(root, 'day 1');
  // Both in one run: CHECK strengthens a 4-week-old page and BUILD publishes new ones.
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  const both = await run({ root, now: new Date('2026-11-30T15:00:00Z'), 'global-mode': 'normal', fetchImpl: fakeFetch({ gscRows: [{ keys: ['how to budget a team offsite retreat', 'https://example.com/'], clicks: 0, impressions: 40, position: 12 }], pageRows: book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 14 })) }), chat: distinctChat() });
  assert.ok(both.did.check.strengthened >= 1, `strengthened: ${both.report.notes.join(' | ')}`);
  assert.ok(both.did.build.published >= 1, 'BUILD published new pages in the same run');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json'))).pages;
  const touched = after.filter((p) => p.published_at === '2026-11-30' || p.strengthen?.before_hash).map((p) => p.rel);
  assert.ok(touched.length >= both.did.build.published + both.did.check.strengthened);
  for (const rel of touched) assert.ok(both.written.files.includes(rel), `${rel} counted (${both.written.files.join(', ')})`);
  assert.equal(finishingStepRuns({ outputs: outputsOf(both) }), true);
});

test('files changed before the run are not counted as this run\'s, and the real git index is untouched', async () => {
  const root = gitSite();
  await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  commitAll(root, 'day 1');
  // Before the run: an edit staged in the real index, and an untracked file.
  fs.appendFileSync(path.join(root, 'download.html'), '\n<!-- local edit -->\n');
  git(root, 'add', 'download.html');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'scratch');
  const indexBefore = git(root, 'diff', '--cached', '--name-only');
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  const r = await run({ root, now: new Date('2026-11-30T15:00:00Z'), 'global-mode': 'normal', stage: 'check', fetchImpl: fakeFetch({ pageRows: book.pages.map((x) => ({ keys: [x.url], clicks: 0, impressions: 30, position: 14 })) }), chat: goodChat() });
  assert.ok(r.did.check.strengthened >= 1);
  assert.equal(indexBefore, 'download.html');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), indexBefore, 'the real index is what it was');
  assert.ok(!r.written.files.includes('download.html') && !r.written.files.includes('notes.txt'), `only this run's writes: ${r.written.files.join(', ')}`);
  assert.ok(r.written.count >= 1);
});

test('could not tell (not a git checkout): pages_written is unknown, a named note says so, and the finishing step runs anyway', async () => {
  const root = site(); // no git
  const r = await run({ root, now: NOW, 'global-mode': 'normal', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.equal(r.written.count, null);
  assert.match(r.report.notes.join('\n'), /NAMED NOTE \[PAGES_WRITTEN_UNREAD\] could not tell which site files this run changed \(.*not a git checkout\)/);
  assert.match(r.census, /pages_written=unknown/);
  assert.equal(outputsOf(r).pages_written, 'unknown');
  assert.equal(finishingStepRuns({ outputs: outputsOf(r) }), true, 'unsure means run it, never skip it');
});

test('the finishing step never runs without a command or when the engine produced no output', () => {
  assert.equal(finishingStepRuns({ postBuild: '', outputs: { mode: 'normal', published: 3, pages_written: 5 } }), false);
  assert.equal(finishingStepRuns({ outputs: {} }), false, 'engine crashed before writing outputs (the commit step is skipped then too)');
  assert.equal(finishingStepRuns({ outputs: { mode: 'normal', published: 0, pages_written: 0 } }), false);
  assert.equal(finishingStepRuns({ outputs: { mode: 'normal', published: 0, pages_written: 1 } }), true);
  // An engine older than v1.17.2 writes no pages_written: unsure, so the step runs (never a silent skip).
  assert.equal(finishingStepRuns({ outputs: { mode: 'normal', published: 0 } }), true);
});

// The finishing step's real shell, run with a failing and a passing site command.
const stepRun = (() => {
  const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Site finishing step'), WORKFLOW.indexOf('- name: Commit and push'));
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at > 0, 'the finishing step has a run: | block');
  const ind = lines[at].match(/^\s*/)[0].length + 2;
  return lines.slice(at + 1).filter((l) => l.trim()).filter((l, i, a) => a.slice(0, i + 1).every((x) => x.match(/^\s*/)[0].length >= ind)).map((l) => l.slice(ind)).join('\n');
})();
function runStep(cmd) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sl-step-'));
  const summary = path.join(dir, 'summary.md');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepRun], { cwd: dir, encoding: 'utf8', env: { ...process.env, POST_BUILD_COMMAND: cmd, PAGES_WRITTEN: '3', GITHUB_STEP_SUMMARY: summary } });
  const log = fs.existsSync(path.join(dir, '.search-loop-run.log')) ? fs.readFileSync(path.join(dir, '.search-loop-run.log'), 'utf8') : '';
  return { status: r.status, out: r.stdout + r.stderr, log, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
}

test('a failing finishing step fails the run with NAMED STOP [POST_BUILD_FAILED] in the run log and summary; a passing one is quiet', () => {
  for (const cmd of ['exit 3', 'false; true', 'false | true']) {
    const r = runStep(cmd);
    assert.equal(r.status, 1, `${cmd}: the step fails (${r.out})`);
    assert.match(r.log, /^NAMED STOP \[POST_BUILD_FAILED\] .*nothing from this run is committed/m, `${cmd}: Open Loops reads it from the run log`);
    assert.match(r.summary, /NAMED STOP \[POST_BUILD_FAILED\]/);
  }
  const ok = runStep('echo built > built.txt');
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.log, '');
  assert.doesNotMatch(ok.summary, /POST_BUILD_FAILED/);
});
