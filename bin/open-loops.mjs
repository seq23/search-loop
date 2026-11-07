// OPEN LOOPS: a gate's named stops become rows on Boss OS's Open Loops list (boss-os docs/open-loops.md).
// One call: every stop still in force is upserted (one row per repo#CODE); every known code that has
// cleared is posted `cleared`, which closes its row "outcome reached". Plain Node, no dependencies.
// No BOSS_OPEN_LOOPS_TOKEN → one line, nothing sent. A failed post is one line; it never fails a gate.
export const INTAKE = 'https://boss.sequoiataylor.com/api/boss/open-loops/intake';

/** The posts one report makes, in order. Pure. */
export function intakePosts({ repo, business, finish, known, stops, words = {} }) {
  const live = new Map(stops.map(s => [s.code, s]));
  const posts = stops.map(s => ({ repo, stop: s.code, business, finish_line: finish, ...(words[s.code] ?? {}) }));
  for (const code of known) if (!live.has(code)) posts.push({ repo, stop: code, cleared: true });
  return posts;
}

export async function reportToOpenLoops(opts, { token = process.env.BOSS_OPEN_LOOPS_TOKEN, fetchImpl = fetch, log = console.log } = {}) {
  const posts = intakePosts(opts);
  if (!token) { log(`open loops: not reported (no BOSS_OPEN_LOOPS_TOKEN here); ${posts.length} stop(s) would be sent.`); return { sent: 0, failed: 0, skipped: posts.length }; }
  let sent = 0, failed = 0;
  for (const body of posts) {
    try {
      const r = await fetchImpl(INTAKE, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (r.ok) sent++; else { failed++; log(`open loops: ${body.stop} refused (${r.status})`); }
    } catch (e) { failed++; log(`open loops: ${body.stop} not sent (${e?.message ?? e})`); }
  }
  log(`open loops: ${sent} reported, ${failed} failed (${posts.filter(p => p.cleared).length} cleared).`);
  return { sent, failed, skipped: 0 };
}
