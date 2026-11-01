// Three-way merge for the engine's own JSON ledger files, used when the push
// has to rebase onto a default branch that moved (another run of the loop on
// the same site wrote the ledger meanwhile). `mine` is this run's version and
// wins any scalar both sides changed; records in lists are joined by their key,
// so neither run's pages, targets or runs are lost.

const RECORD_KEYS = ['slug', 'id', 'url', 'query', 'path', 'run_id', 'hash', 'week', 'at'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function recordKey(lists) {
  const items = lists.flat();
  if (!items.length || !items.every(isObj)) return null;
  return RECORD_KEYS.find((k) => items.every((it) => typeof it[k] === 'string' || typeof it[k] === 'number')) || null;
}

function mergeList(base, theirs, mine) {
  const key = recordKey([base, theirs, mine]);
  if (!key) {
    // Plain values: their order, then anything new of mine; a value either side dropped stays dropped.
    const seen = new Set();
    const out = [];
    const baseSet = new Set(base.map((v) => JSON.stringify(v)));
    const theirSet = new Set(theirs.map((v) => JSON.stringify(v)));
    const mySet = new Set(mine.map((v) => JSON.stringify(v)));
    for (const v of [...theirs, ...mine]) {
      const s = JSON.stringify(v);
      if (seen.has(s)) continue;
      if (baseSet.has(s) && (!theirSet.has(s) || !mySet.has(s))) continue;
      seen.add(s);
      out.push(v);
    }
    return out;
  }
  const byKey = (list) => new Map(list.map((it) => [String(it[key]), it]));
  const b = byKey(base), t = byKey(theirs), m = byKey(mine);
  const out = [];
  const done = new Set();
  for (const k of [...t.keys(), ...m.keys()]) {
    if (done.has(k)) continue;
    done.add(k);
    const inT = t.has(k), inM = m.has(k);
    if (b.has(k) && (!inT || !inM)) {
      // Deleted on one side: keep it only if the other side changed it since base.
      const kept = inT ? t.get(k) : m.get(k);
      if (same(kept, b.get(k))) continue;
      out.push(kept);
      continue;
    }
    if (inT && inM) out.push(mergeJson(b.get(k), t.get(k), m.get(k)));
    else out.push(inT ? t.get(k) : m.get(k));
  }
  return out;
}

export function mergeJson(base, theirs, mine) {
  if (same(theirs, mine)) return mine;
  if (base !== undefined && same(base, theirs)) return mine;
  if (base !== undefined && same(base, mine)) return theirs;
  if (Array.isArray(theirs) && Array.isArray(mine)) return mergeList(Array.isArray(base) ? base : [], theirs, mine);
  if (isObj(theirs) && isObj(mine)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const inT = k in theirs, inM = k in mine;
      if (inT && inM) out[k] = mergeJson(b[k], theirs[k], mine[k]);
      else if (k in b) { const kept = inT ? theirs[k] : mine[k]; if (!same(kept, b[k])) out[k] = kept; }
      else out[k] = inT ? theirs[k] : mine[k];
    }
    return out;
  }
  return mine;
}
