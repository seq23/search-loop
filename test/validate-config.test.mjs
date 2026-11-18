// validate-config checks the model routing file too (v1.12.0), with no network:
// peace-be-still's first routing file (paid_fallback, unpriced `models`) passed the
// old config-only check and then failed every scheduled run with FAIL_LOUD.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('bin/search-loop.mjs');
function site(routing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-validate-'));
  const cfg = JSON.parse(fs.readFileSync('examples/search-loop.config.json', 'utf8'));
  cfg.llm = { routing_file: 'config/llm_routing.json' };
  fs.writeFileSync(path.join(dir, 'search-loop.config.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(dir, 'config'));
  if (routing) fs.writeFileSync(path.join(dir, 'config/llm_routing.json'), JSON.stringify(routing));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [CLI, 'validate-config', '--root', dir], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } });
const good = { policy: { max_cost_usd: 0, fallback_to_paid: false }, free_models: [{ id: 'a/b:free', pricing: { prompt: '0', completion: '0' } }] };

test('validate-config passes a $0 routing file', () => {
  const r = run(site(good));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /config OK/);
});

test('validate-config fails the old peace-be-still routing shape with the run\'s FAIL_LOUD message', () => {
  const r = run(site({ policy: { max_cost_usd: 0, paid_fallback: false }, models: [{ id: 'a/b:free' }] }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NAMED STOP \[CONFIG_INVALID\] FAIL_LOUD .*policy\.fallback_to_paid must be false/);
});

test('validate-config fails an unpriced model and a missing routing file', () => {
  const r = run(site({ policy: good.policy, free_models: [{ id: 'a/b:free' }] }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /every model must be priced \$0\/\$0/);
  const m = run(site(null));
  assert.equal(m.status, 1);
  assert.match(m.stderr, /CONFIG_INVALID.*llm_routing\.json/);
});
