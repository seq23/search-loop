// The ledger, committed to the site repo under cfg.ledger_dir.
import path from 'node:path';
import { readJson, writeJson } from './util.mjs';

export const FILES = {
  targets: 'targets.json',
  receipt: 'discovery-receipt.json',
  pages: 'pages.json',
  cap: 'cap.json',
  consolidation: 'consolidation-ledger.json',
  winners: 'winners.json',
  runs: 'runs.json',
  ai_daily: 'ai-daily.json',
  drafts: 'drafts',
  snapshots: 'snapshots',
};

export function ledger(cfg) {
  const dir = path.join(cfg.root, cfg.ledger_dir);
  const p = (k) => path.join(dir, FILES[k]);
  return {
    dir,
    path: p,
    read(k, fallback) { return readJson(p(k), fallback); },
    write(k, data) { writeJson(p(k), data); },
    pages() { return readJson(p('pages'), { schema: 'search-loop-pages-v1', pages: [] }); },
    snapshotPath(hash) { return path.join(dir, FILES.snapshots, `${hash}.html`); },
  };
}
