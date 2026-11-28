// v1.17.3 (Rule 0): a sitemap file the site names in distinct.sitemap_files must be there and hold
// URLs. Before, a named file that was missing was skipped in silence (src/distinct.mjs), the
// distinct-intent gate passed having compared against none of the site's sitemap pages, and the
// loop could publish a twin of a page only the sitemap knew about (found reviewing seq23/WKYS#3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/search-loop.mjs';
import { sitemapRoutes } from '../src/distinct.mjs';
import { isoWeek } from '../src/util.mjs';
import { site, fakeFetch, goodChat, NOW } from './harness.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'search-loop.mjs');
const SITEMAP_ONLY = '<urlset><url><loc>https://example.com/guides/weekly-budget-template/</loc></url></urlset>';
const QUERIES = ['weekly budget template', 'how to pay contractors on time'];

function seed(root, queries) {
  fs.mkdirSync(path.join(root, 'data/search-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/search-loop/targets.json'), JSON.stringify({ schema: 'search-loop-targets-v1', week: isoWeek(NOW), targets: queries.map((query, i) => ({ query, kind: 'new', score: 50 - i, signals: {} })), strengthen: [] }));
}
const questionPages = (root) => { try { return fs.readdirSync(path.join(root, 'questions')); } catch { return []; } };
const draftCalls = (calls) => calls.filter((m) => /Search to answer/.test(m[1]?.content || '')).length;

// The run must reject with the named stop, exit code 1 (problems: the caller skips the commit and
// the run is red), before any draft is asked for or any page is written.
async function assertStops(root, code, file) {
  const calls = [];
  await assert.rejects(
    run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: goodChat(calls) }),
    (e) => {
      assert.equal(e.stopCode, code);
      assert.equal(e.code, 1, 'exit code 1, never 0');
      assert.ok(e.message.startsWith(`NAMED STOP [${code}] ${file} `), `the stop names the path: ${e.message}`);
      return true;
    });
  assert.equal(draftCalls(calls), 0, 'no draft was asked for');
  assert.deepEqual(questionPages(root), [], 'no page was written');
}

test('a named sitemap file that is missing is NAMED STOP [SITEMAP_MISSING] naming the path; nothing drafted or published', async () => {
  const root = site({ cfg: { distinct: { sitemap_files: ['public/sitemap.xml'] } } });
  seed(root, QUERIES);
  await assertStops(root, 'SITEMAP_MISSING', 'public/sitemap.xml');
  // a directory at that path is unreadable, the same stop
  fs.mkdirSync(path.join(root, 'public/sitemap.xml'), { recursive: true });
  await assertStops(root, 'SITEMAP_MISSING', 'public/sitemap.xml');
});

test('a named sitemap file with 0 URLs is NAMED STOP [SITEMAP_EMPTY] naming the path; nothing drafted or published', async () => {
  for (const body of ['', '<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n']) {
    const root = site({ cfg: { distinct: { sitemap_files: ['public/sitemap.xml'] } } });
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public/sitemap.xml'), body);
    seed(root, QUERIES);
    await assertStops(root, 'SITEMAP_EMPTY', 'public/sitemap.xml');
  }
});

test('one missing file among several named ones still stops (no partial compare)', async () => {
  const root = site({ cfg: { distinct: { sitemap_files: ['sitemap-a.xml', 'sitemap-b.xml'] } } });
  fs.writeFileSync(path.join(root, 'sitemap-a.xml'), SITEMAP_ONLY);
  seed(root, QUERIES);
  await assertStops(root, 'SITEMAP_MISSING', 'sitemap-b.xml');
});

test('a named sitemap file that is there is read: its URLs reach the distinct-intent gate', async () => {
  const root = site({ cfg: { distinct: { sitemap_files: ['public/sitemap.xml'] } } });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/sitemap.xml'), SITEMAP_ONLY);
  seed(root, QUERIES);
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: goodChat() });
  const book = JSON.parse(fs.readFileSync(path.join(root, 'data/search-loop/pages.json')));
  // the search only the named sitemap answers is redirected to that URL, never built
  assert.equal(book.redirected.find((x) => x.query === 'weekly budget template')?.url, 'https://example.com/guides/weekly-budget-template/');
  assert.ok(!book.pages.some((p) => p.query === 'weekly budget template'));
  // negative proof: the distinct search still publishes
  assert.ok(book.pages.some((p) => p.query === 'how to pay contractors on time'));
  assert.ok(r.did.build.published >= 1);
  // a sitemap index (only .xml children) holds URLs, so it is not a stop; its .xml links are not pages
  fs.writeFileSync(path.join(root, 'public/sitemap.xml'), '<sitemapindex><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap></sitemapindex>');
  assert.deepEqual(sitemapRoutes({ root, base_url: 'https://example.com', distinct: { sitemap_files: ['public/sitemap.xml'] } }), []);
});

test('no sitemap_files key and no sitemap at the root: unchanged, the run builds', async () => {
  const root = site();
  assert.equal(fs.readdirSync(root).filter((f) => /^sitemap.*\.xml$/i.test(f)).length, 0);
  assert.deepEqual(sitemapRoutes({ root, base_url: 'https://example.com' }), []);
  seed(root, QUERIES);
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.ok(r.did.build.published >= 1, `published ${r.did.build.published}`);
  // the default still reads a root sitemap*.xml when one is there
  fs.writeFileSync(path.join(root, 'sitemap.xml'), SITEMAP_ONLY);
  assert.deepEqual(sitemapRoutes({ root, base_url: 'https://example.com' }), ['/guides/weekly-budget-template/']);
});

test('no sitemap_files key and an empty root sitemap.xml: unchanged (skipped, never a stop), the run builds', async () => {
  const root = site();
  fs.writeFileSync(path.join(root, 'sitemap.xml'), '');
  seed(root, QUERIES);
  const r = await run({ root, now: NOW, 'global-mode': 'normal', stage: 'build', fetchImpl: fakeFetch(), chat: goodChat() });
  assert.ok(r.did.build.published >= 1, `published ${r.did.build.published}`);
});

test('the real command line exits 1 (never 0) with the stop on stderr', () => {
  const root = site({ cfg: { distinct: { sitemap_files: ['public/sitemap.xml'] } } });
  seed(root, QUERIES);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const p = spawnSync(process.execPath, [BIN, 'run', '--root', root, '--config', 'search-loop.config.json', '--stage', 'build', '--global-mode', 'normal'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(p.status, 1, `exit ${p.status}; stderr: ${p.stderr.slice(-400)}`);
  assert.match(p.stderr, /NAMED STOP \[SITEMAP_MISSING\] public\/sitemap\.xml /);
  assert.deepEqual(questionPages(root), []);
});
