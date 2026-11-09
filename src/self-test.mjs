// --self-test: the engine proves its guards catch every broken shape, and
// that the known-good fixture passes (a gate that fails everything is blind too).
import { gate, gateReport, LIMITS } from './gate.mjs';
import { render } from './render.mjs';
import { fixtureConfig, fixtureDraft, FIXTURE_CONFIG_RAW } from './fixture.mjs';
import { checkConfig } from './config.mjs';
import { lowest, MODE_RULES, OFF_SENTENCE, parseModeFile } from './mode.mjs';
import { checkReport, REPORT_FIELDS } from './report.mjs';
import { nextCap } from './cap.mjs';
import { sameIntent, intentWords } from './distinct.mjs';
import { publishedFrozen } from './config.mjs';
import { decide } from './check.mjs';
import { cleanDraft } from './build.mjs';
import { aiEngineFor } from './analytics.mjs';
import { NamedStop, EXIT } from './util.mjs';

const TODAY = '2026-11-01';
const page = (cfg, d) => ({ query: 'how to plan your week as a founder', html: render(cfg, { slug: 'how-to-plan-your-week', draft: d, related: [{ route: '/weekly-review/', anchor: 'How to run a weekly review' }], published: TODAY }), facts: d.facts });
const goodReport = () => ({ schema: 'search-loop-week-v1', week: '2026-W44', site: 'example.com', generated_at: new Date().toISOString(), state: 'running', published: 3, indexed: 'not read: x', pace: 10, ai_visitors: 0, ai_bot_hits: 'not read: y', conversions: 'not read: z', wins: 0, undone: 0, merged: 0, held_by_cap: 0, redirected: [], cap: { max_live_pages: 20, live: 3, room: 17, why: 'started at 20' }, notes: [], run_url: null });

export function cases() {
  const cfg = fixtureConfig();
  const g = (mut, cfgMut = (c) => c) => () => { const d = fixtureDraft(); mut(d); return gate(page(cfgMut({ ...cfg }), d), { cfg: cfgMut({ ...cfg }), corpus: [], siblings: [] }); };
  const health = (c) => ({ ...c, health_gate: 'dental' });
  const htmlMut = (fn) => () => { const d = fixtureDraft(); const p = page(cfg, d); p.html = fn(p.html); return gate(p, { cfg, corpus: [], siblings: [] }); };
  return [
    ['meta too short', g((d) => { d.meta_description = 'Plan your week.'; })],
    ['only two FAQs', g((d) => { d.faq = d.faq.slice(0, 2); })],
    ['FAQ answer too short', g((d) => { d.faq[0].a = 'About twenty minutes.'; })],
    ['thin page (under 75% of 600 words)', g((d) => { d.sections = d.sections.slice(0, 1).map((x) => ({ ...x, paragraphs: x.paragraphs.slice(0, 1) })); d.faq = d.faq.slice(0, 3); })],
    ['title far too short (under 75% of 30)', htmlMut((h) => h.replace(/<title>[^<]*<\/title>/, '<title>Plan — Example Planner</title>'))],
    ['direct answer far too short', g((d) => { d.direct_answer = 'Weekly planning is choosing three outcomes.'; })],
    ['leaked placeholder text', g((d) => { d.sections[0].paragraphs[0] += ' [insert example here]'; })],
    ['no verified fact', g((d) => { d.facts = d.facts.map((f) => ({ ...f, verified: false })); })],
    ['unsourced statistic', g((d) => { d.sections[0].paragraphs[0] += ' Studies show 73% of founders never plan.'; })],
    ['invented review', g((d) => { d.sections[1].paragraphs[0] += ' Customers love it and rated it 5 stars.'; })],
    ['invented credential', g((d) => { d.sections[1].paragraphs[1] += ' Dr. Smith, our board-certified expert, agrees.'; })],
    ['named person quote', g((d) => { d.sections[2].paragraphs[0] += ' According to Jane Porter this always works.'; })],
    ['two H1s', htmlMut((h) => h.replace('<h2>', '<h1>Another</h1><h2>'))],
    ['missing og:image', htmlMut((h) => h.replace(/<meta content="[^"]*" property="og:image"\/>/, ''))],
    ['link to a disallowed host', htmlMut((h) => h.replace('</article>', '<p><a href="https://elsewhere.example.org/x">another site</a></p></article>'))],
    ['does not end in the action', htmlMut((h) => h.replace('</article>', '<p><a href="/weekly-review/">How to run a weekly review</a></p></article>'))],
    ['date not visible', htmlMut((h) => h.replace(/<p class="page-dates">[\s\S]*?<\/p>/, ''))],
    ['FAQ question not visible', htmlMut((h) => h.replace('<h3>How long should weekly planning take?</h3>', '<h3>Planning time</h3>'))],
    ['unsourced fact line', htmlMut((h) => h.replace(/(<section data-search-loop="facts">[\s\S]*?)<\/ul><\/section>/, '$1<li>Most founders plan on Sunday.</li></ul></section>'))],
    ['one source only (v1.5.0)', g((d) => { d.facts = d.facts.slice(0, 1); })],
    ['no list or table in the body (v1.5.0)', g((d) => { d.sections = d.sections.map((x) => ({ ...x, bullets: [] })); })],
    ['near-duplicate', () => { const d = fixtureDraft(); const p = page(cfg, d); return gate(p, { cfg, corpus: [{ route: '/copy/', sh: new Set(awaitShingles(p.html)) }], siblings: [] }); }],
    ['site banned word (gate.banned_patterns)', g((d) => { d.sections[0].paragraphs[0] += ' This proves your plan works.'; }, (c) => ({ ...c, gate: { banned_patterns: ['\\bproves\\b'] } }))],
    ['config: banned pattern that is not a regex', () => checkConfig({ ...FIXTURE_CONFIG_RAW, gate: { banned_patterns: ['('] } })],
    ['health: painless', g((d) => { d.sections[0].paragraphs[0] += ' The visit is painless.'; }, health)],
    ['health: outcome promise', g((d) => { d.sections[0].paragraphs[0] += ' This will eliminate the problem.'; }, health)],
    ['health: medical advice', g((d) => { d.sections[0].paragraphs[1] += ' You should stop taking your medication first.'; }, health)],
    ['health: invented hours', g((d) => { d.sections[1].paragraphs[1] += ' We are open until 9pm with walk-ins welcome.'; }, health)],
    ['config: no action', () => checkConfig({ ...FIXTURE_CONFIG_RAW, action: undefined })],
    ['config: output inside protected path', () => checkConfig({ ...FIXTURE_CONFIG_RAW, protected_paths: ['questions'] })],
    ['config: per-day run guard over 30', () => checkConfig({ ...FIXTURE_CONFIG_RAW, cap: { max_per_day: 40 } })],
    ['config: cap growth share over 0.5', () => checkConfig({ ...FIXTURE_CONFIG_RAW, cap: { grow_share: 2 } })],
    ['report: redirect without the existing URL', () => checkReport({ ...goodReport(), redirected: [{ query: 'x', strengthen: null }] })],
    ['report: cap without why', () => checkReport({ ...goodReport(), cap: { max_live_pages: 20, why: '' } })],
    ['config: action on another host', () => checkConfig({ ...FIXTURE_CONFIG_RAW, action: { label: 'x', url: 'https://other.example.org/buy' } })],
    ['report: missing field', () => { const r = goodReport(); delete r.ai_bot_hits; return checkReport(r); }],
    ['report: invented zero instead of not read', () => checkReport({ ...goodReport(), conversions: '0' })],
    ['report: off without the sentence', () => checkReport({ ...goodReport(), state: 'off' })],
    ['report: wrong schema', () => checkReport({ ...goodReport(), schema: 'search-loop-week-v2' })],
    ['mode: site config raises the global switch', () => (lowest('slow', 'normal') === 'slow' && lowest('off', 'normal') === 'off' ? ['caught'] : [])],
  ];
}

// Style and over-limit shapes: each must be NOTED and must NOT block the page
// (her ruling, 2 Nov 2026: over a limit never fails; wording is never a block).
export function noteCases() {
  const cfg = fixtureConfig();
  const rep = (mut, htmlFn = (h) => h) => () => { const d = fixtureDraft(); mut(d); const p = page(cfg, d); p.html = htmlFn(p.html); return gateReport(p, { cfg, corpus: [], siblings: [] }); };
  return [
    ['title over 65 chars', rep(() => {}, (h) => h.replace(/<title>[^<]*<\/title>/, '<title>How to plan your week as a founder when the whole week is on fire — Example Planner</title>'))],
    ['title without the search first', rep((d) => { d.title_lead = 'Our favourite productivity thoughts'; })],
    ['site name twice in the title', rep(() => {}, (h) => h.replace(/<title>[^<]*<\/title>/, '<title>Example Planner: how to plan your week — Example Planner</title>'))],
    ['meta description a little short', rep((d) => { d.meta_description = d.meta_description.slice(0, 100); })],
    ['direct answer too long', rep((d) => { d.direct_answer += ' ' + d.direct_answer; })],
    ['direct answer does not define', rep((d) => { d.direct_answer = d.direct_answer.replace(/\bis\b/g, 'means').replace(/\bare\b/g, 'mean'); })],
    ['FAQ answer too long', rep((d) => { d.faq[0].a += ' ' + d.faq[0].a; })],
    ['seven FAQs', rep((d) => { d.faq.push(...d.faq.slice(0, 3).map((f) => ({ q: f.q.replace('?', ' again?'), a: f.a }))); })],
    ['page a little under 600 words', rep((d) => { d.sections = d.sections.slice(0, 1); })],
    ['weak anchor', rep(() => {}, (h) => h.replace('<section class="faq">', '<p><a href="/weekly-review/">click here</a></p><section class="faq">'))],
    ['filler phrase', rep((d) => { d.sections[0].paragraphs[0] += ' Let us delve into it.'; })],
  ];
}

// The renderer fits lengths before the gate sees them.
export function fitCases() {
  const cfg = fixtureConfig();
  const titleOf = (d) => render(cfg, { slug: 'x', draft: d, published: TODAY }).match(/<title>([^<]*)<\/title>/)[1];
  const metaOf = (d) => render(cfg, { slug: 'x', draft: d, published: TODAY }).match(/<meta content="([^"]*)" name="description"/)[1];
  const named = (t) => t.split(cfg.site_name).length - 1;
  return [
    ['long title lead is cut to 65', () => { const d = fixtureDraft(); d.title_lead = 'How to plan your week as a founder when everything is on fire and nothing works'; const t = titleOf(d); return t.length <= LIMITS.title[1] && named(t) === 1 && t.startsWith('How to plan your week'); }],
    ['site name in the lead appears once', () => { const d = fixtureDraft(); d.title_lead = 'Example Planner: how to plan your week'; return named(titleOf(d)) === 1; }],
    ['short lead falls back to the H1', () => { const d = fixtureDraft(); d.title_lead = 'Plan'; return titleOf(d).length >= LIMITS.title[0]; }],
    // v1.9.2 (porchandparty901.com, 9 Nov 2026): the writer turns the two leads free models give that define
    // nothing into "X is ...", so the rendered answer under the H1 passes page-shape b4.
    ['a lead that defines nothing is written "X is ..."', () => ['To set up a hotel room for a romantic night, check in early, clear the surfaces and dim the lights.', 'Party rentals Memphis services include party game rentals, celebration setups and grazing tables.']
      .every((a) => { const h = render(cfg, { slug: 'x', draft: cleanDraft({ ...fixtureDraft(), direct_answer: a }), published: TODAY }); return /\b(is|are)\b/.test(stripTags(h.match(/<\/h1>[\s\S]*?<p[\s>][\s\S]*?<\/p>/)[0].split(/<\/h1>/)[1])); })],
    ['long meta cut to 160', () => { const d = fixtureDraft(); d.meta_description += ' ' + d.meta_description; return metaOf(d).length <= LIMITS.meta[1]; }],
  ];
}

// shingles helper without a circular import at module load
import { shingles, stripTags } from './util.mjs';
function awaitShingles(html) { return [...shingles(stripTags(html.match(/<main[\s\S]*?<\/main>/)[0]))]; }

export async function selfTest() {
  const cfg = fixtureConfig();
  const d = fixtureDraft();
  const goodProblems = gate(page(cfg, d), { cfg, corpus: [], siblings: [] });
  if (goodProblems.length) throw new NamedStop('SELF_TEST_GOOD_FAILS', `the known-good fixture fails the gate: ${goodProblems.join('; ')}`, EXIT.PROBLEMS);
  if (checkConfig(FIXTURE_CONFIG_RAW).length) throw new NamedStop('SELF_TEST_GOOD_FAILS', `fixture config invalid: ${checkConfig(FIXTURE_CONFIG_RAW).join('; ')}`, EXIT.PROBLEMS);
  if (checkReport(goodReport()).length) throw new NamedStop('SELF_TEST_GOOD_FAILS', 'good report rejected', EXIT.PROBLEMS);
  const extra = [
    ['mode table: off still builds', () => (MODE_RULES.off.build || MODE_RULES.off.find !== 'never' ? [] : ['caught'])],
    ['mode table: slow cap is not 3 / still strengthens', () => (MODE_RULES.slow.build_cap === 3 && !MODE_RULES.slow.strengthen && MODE_RULES.slow.check === 'weekly' ? ['caught'] : [])],
    ['mode: unknown value accepted', () => (parseModeFile('{"mode":"turbo"}').mode === null ? ['caught'] : [])],
    ['cap: grows with no Search Console data', () => (nextCap(cfg, { max_live_pages: 50, history: [] }, { notRead: 'x' }).cap.max_live_pages === 50 ? ['caught'] : [])],
    ['cap: grows when impressions fell or stayed flat', () => (nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 90, prev: 100 }).cap.max_live_pages < 50 && nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 100, prev: 100 }).cap.max_live_pages === 50 ? ['caught'] : [])],
    ['cap: does not grow on growth', () => (nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 120, prev: 100 }).cap.max_live_pages === 55 ? ['caught'] : [])],
    ['cap: change not logged', () => (nextCap(cfg, { max_live_pages: 50, history: [] }, { last: 120, prev: 100 }).cap.history.length === 1 ? ['caught'] : [])],
    ['distinct: same wording passes as new', () => (sameIntent(intentWords('how to plan your week'), intentWords('weekly plan: how do I plan my week')) && sameIntent(intentWords('plan my week'), intentWords('how to plan your week')) ? ['caught'] : [])],
    ['distinct: template variant passes as new', () => (sameIntent(intentWords('wedding budget spreadsheet for a small wedding'), intentWords('wedding budget spreadsheet')) ? ['caught'] : [])],
    ['distinct: different intents merged', () => (sameIntent(intentWords('how to plan your week'), intentWords('how to pay wedding vendors')) ? [] : ['caught'])],
    ['frozen: Horse or Hicks published pages not frozen', () => (publishedFrozen({ base_url: 'https://www.horselegalguide.com' }) && publishedFrozen({ base_url: 'https://hicksconsulting.org' }) && !publishedFrozen({ base_url: 'https://example.com' }) ? ['caught'] : [])],
    ['decide: worse page not undone', () => (decide({ strengthen: { at: '2026-10-01', baseline_position: 12 } }, { position: 18, checkpoint: 'w8' }, { rules: MODE_RULES.normal, today: TODAY }).includes('undo') ? ['caught'] : [])],
    ['decide: slow mode strengthens', () => (decide({}, { position: 14, checkpoint: 'w4' }, { rules: MODE_RULES.slow, today: TODAY }).includes('strengthen') ? [] : ['caught'])],
    ['decide: 90-day zero not merged', () => (decide({}, { impressions: 0, checkpoint: 'd90', source: 'search_console' }, { rules: MODE_RULES.normal, today: TODAY }).includes('merge') ? ['caught'] : [])],
    ['privacy: full referrer URL kept', () => (aiEngineFor('https://chatgpt.com/c/secret-question?q=private') === 'chatgpt' && aiEngineFor('https://www.bing.com/search?q=x') === null ? ['caught'] : [])],
    ['off sentence missing', () => (OFF_SENTENCE === 'Search loop is switched off (mode=off)' ? ['caught'] : [])],
  ];
  const all = [...cases(), ...extra];
  const missed = all.filter(([, f]) => f().length === 0).map(([n]) => n);
  if (missed.length) throw new NamedStop('SELF_TEST_BLIND', `not caught: ${missed.join(', ')}`, EXIT.PROBLEMS);
  const noted = noteCases();
  const blocks = noted.filter(([, f]) => { const r = f(); return r.problems.length > 0 || r.notes.length === 0; }).map(([n, f]) => `${n} (${f().problems.join('; ') || 'no note'})`);
  if (blocks.length) throw new NamedStop('SELF_TEST_PETTY', `a style or over-limit shape blocks the page or goes unnoted: ${blocks.join(', ')}`, EXIT.PROBLEMS);
  const unfit = fitCases().filter(([, f]) => !f()).map(([n]) => n);
  if (unfit.length) throw new NamedStop('SELF_TEST_UNFIT', `the renderer did not fit: ${unfit.join(', ')}`, EXIT.PROBLEMS);
  if (all.length < 40) throw new NamedStop('SELF_TEST_TOO_SMALL', `only ${all.length} broken shapes (floor 40)`, EXIT.NOTHING);
  return `SELF-TEST OK — ${all.length} broken shapes caught; ${noted.length} style shapes noted, never blocking; ${fitCases().length} lengths fitted; the known-good page passes the gate`;
}
