// The quality gate every new or strengthened page passes BEFORE it is
// published. Her checklist's every-page items (boss-os searchReadiness
// checklist.json, phase B + d4) plus: no invented people, credentials, reviews
// or stats; near-duplicate check; the health/dental gate when configured.
// Fail -> fix once or drop. Never publish thin.
//
// Two kinds of finding (her ruling, 2 Nov 2026: "no petty validation"):
// - problems: block the page. Safety and broken output only: invented stats,
//   reviews, credentials, people; health claims; link targets; unsourced fact
//   lines; missing structure (H1, FAQPage, social tags, date, action); leaked
//   placeholders; near-duplicates; and a length FLOOR missed by more than 25%.
// - notes: never block. Anything over a length limit, a floor missed by less
//   than 25%, and wording/style rules (search-first title, site name once,
//   "X is ..." answer, weak anchors, filler phrases). render.mjs fits the title
//   and meta first, so most of these never fire.
import { stripTags, wordCount, shingles, jaccard, tokenOverlap } from './util.mjs';

export const LIMITS = { title: [30, 65], meta: [120, 160], answer: [40, 60], faq: [3, 6], faqAnswer: [40, 60], minWords: 600, nearDup: 0.35 };

// The one floor rule: under a minimum blocks only below 75% of it; over a
// maximum never blocks.
export const FLOOR_SHARE = 0.75;
export const belowFloor = (n, min) => n < min * FLOOR_SHARE;
// Length band -> 'block' (under 75% of the floor), 'note' (outside the band), or null.
export function band(n, [min, max]) {
  if (belowFloor(n, min)) return 'block';
  return n < min || n > max ? 'note' : null;
}

const STAT = /(\b\d+(\.\d+)?\s?(%|percent\b)|\b\d+\s+(out of|in)\s+\d+\b|\b(studies|research|surveys?|data) (show|shows|find|finds|found|suggests?)\b|\bstatistic)/i;
const REVIEW = /(testimonial|\breviews? (from|by)\b|\brated \d|\b\d(\.\d)?\s?stars?\b|\b(customers|clients|users|patients) (say|love|rave)\b|\bfive-star\b)/i;
const CREDENTIAL = /(\bDr\.\s?[A-Z]|\bPh\.?D\b|\bM\.D\.|\bboard[- ]certified\b|\baward[- ]winning\b|\bour (team of )?experts\b|\b\d+\+? years of experience\b|\bas seen (on|in)\b)/;
const PERSON_QUOTE = /([Aa]ccording to [A-Z][a-z]+ [A-Z][a-z]+|[A-Z][a-z]+ [A-Z][a-z]+,? (a|an|the) [a-z]+ (at|from|with) |“[^”]{10,}”\s?[—-]\s?[A-Z])/;
// Unfinished or leaked model output: a reader sees it, so it blocks.
const PLACEHOLDER = /(lorem ipsum|as an ai\b|\[insert|\{\{|todo:)/i;
// Stock filler phrases: style only, a note.
const FILLER = /(in today's fast-paced world|delve into)/i;
const WEAK_ANCHOR = /^(click here|here|read more|learn more|this|link|more)$/i;
export const HEALTH = {
  outcome: /\b(cures?d?|heals?|guarantee[sd]?|guaranteed results|painless|pain[- ]free|100% (safe|effective)|will (fix|eliminate|resolve|reverse)|permanent(ly)? (fix|results)|no side effects|risk[- ]free)\b/i,
  advice: /\b(you should (take|stop taking|start taking)|dosage|dose of|mg\b|prescri(be|ption) (for you|you)|self[- ]diagnos|diagnose yourself|instead of seeing a (doctor|dentist))\b/i,
  hours: /\b(open (24|until|on)|\d{1,2}(:\d\d)?\s?(am|pm)\s?[-–]\s?\d{1,2}|same[- ]day appointments?|walk-ins? welcome)\b/i,
  offer: /\b(we offer|our services include|we provide|we specialize)\b/i,
};

function sections(html) {
  const main = (html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  const h1s = html.match(/<h1[\s>][\s\S]*?<\/h1>/gi) || [];
  const afterH1 = main.split(/<\/h1>/i)[1] || '';
  const firstP = stripTags((afterH1.match(/<p[\s>][\s\S]*?<\/p>/i) || [''])[0]);
  return { main, h1s, firstP };
}

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); out.push(...(Array.isArray(j) ? j : j['@graph'] || [j])); } catch { out.push({ '@type': 'INVALID' }); }
  }
  return out;
}

// page: { query, title, html, facts:[{claim, source_url, verified}] }
// ctx: { cfg, corpus:[{route, sh}], siblings:[{route, sh}], selfRoute }
export function gate(page, ctx) {
  return gateReport(page, ctx).problems;
}

// { problems: [] block the page, notes: [] never block }
export function gateReport(page, ctx) {
  const { cfg } = ctx;
  const p = [];
  const notes = [];
  const lengthRule = (n, lim, msg) => { const b = band(n, lim); if (b === 'block') p.push(msg); else if (b === 'note') notes.push(msg); };
  const html = page.html || '';
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const meta = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1] || '';
  const { main, h1s, firstP } = sections(html);
  const text = stripTags(main);
  const verifiedFacts = (page.facts || []).filter((f) => f.verified);
  const factText = verifiedFacts.map((f) => f.claim).join(' ');

  // B1 / B10 title
  lengthRule(title.length, LIMITS.title, `b1 title is ${title.length} chars (aim ${LIMITS.title.join('-')})`);
  const nameHits = title.split(cfg.site_name).length - 1;
  if (nameHits !== 1) notes.push(`b10 title must name "${cfg.site_name}" exactly once (found ${nameHits})`);
  const lead = title.split(/\s[—|-]\s/)[0];
  if (tokenOverlap(lead, page.query) < 0.5) notes.push('b1 title does not put the search first');
  // B2 meta
  lengthRule(meta.length, LIMITS.meta, `b2 meta description is ${meta.length} chars (aim ${LIMITS.meta.join('-')})`);
  // B3 one H1
  if (h1s.length !== 1) p.push(`b3 needs exactly one H1 (found ${h1s.length})`);
  // B4 direct answer first
  const aw = wordCount(firstP);
  lengthRule(aw, LIMITS.answer, `b4 direct answer under the H1 is ${aw} words (aim ${LIMITS.answer.join('-')})`);
  if (!/\b(is|are)\b/.test(firstP)) notes.push('b4 direct answer does not define: "X is ..."');
  // B5 FAQ visible + one FAQPage
  const ld = jsonLd(html);
  if (ld.some((x) => x['@type'] === 'INVALID')) p.push('c structured data block is not valid JSON');
  const faqs = ld.filter((x) => x['@type'] === 'FAQPage');
  if (faqs.length !== 1) p.push(`b5 needs exactly one FAQPage (found ${faqs.length})`);
  const qs = faqs[0]?.mainEntity || [];
  lengthRule(qs.length, LIMITS.faq, `b5 FAQ has ${qs.length} questions (aim ${LIMITS.faq.join('-')})`);
  for (const q of qs) {
    if (!text.includes(stripTags(q.name))) p.push(`b5 FAQ question not visible: "${String(q.name).slice(0, 60)}"`);
    const n = wordCount(q.acceptedAnswer?.text);
    lengthRule(n, LIMITS.faqAnswer, `b5 FAQ answer is ${n} words (aim ${LIMITS.faqAnswer.join('-')}): "${String(q.name).slice(0, 50)}"`);
  }
  // B6 social tags
  for (const t of ['og:title', 'og:description', 'og:type', 'og:url', 'og:site_name', 'og:image', 'og:image:width', 'og:image:height']) {
    if (!new RegExp(`property=["']${t}["']`).test(html)) p.push(`b6 missing ${t}`);
  }
  // B8 anchors + alt
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]; const anchor = stripTags(m[2]);
    if (WEAK_ANCHOR.test(anchor)) notes.push(`b8 weak anchor text "${anchor}"`);
    if (/^(mailto:|tel:|#)/.test(href)) continue;
    const abs = href.startsWith('/') ? cfg.base_url + href : href;
    const allowedSource = verifiedFacts.some((f) => f.source_url === href);
    if (!allowedSource && !cfg.allowed_link_targets.some((t) => abs.startsWith(t))) p.push(`links: ${href} is not an allowed link target`);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\balt=["'][^"']+["']/.test(m[0]) && !/role=["']presentation/.test(m[0])) p.push('b8 image without alt text');
  // B9 word count
  const wc = wordCount(text);
  if (belowFloor(wc, LIMITS.minWords)) p.push(`b9 ${wc} words of visible text (under ${Math.ceil(LIMITS.minWords * FLOOR_SHARE)}, 75% of the ${LIMITS.minWords} aim) — thin`);
  else if (wc < LIMITS.minWords) notes.push(`b9 ${wc} words of visible text (aim ${LIMITS.minWords}+)`);
  // D4 dates visible
  const art = ld.find((x) => x.datePublished);
  if (!art) p.push('d4 needs datePublished in structured data');
  else if (!text.includes(String(art.datePublished).slice(0, 10)) && !html.includes(`datetime="${String(art.datePublished).slice(0, 10)}`)) p.push('d4 published date is not visible on the page');
  // The site's one action, at the end.
  const actionAbs = cfg.action.url.startsWith('/') ? cfg.action.url : cfg.action.url.replace(cfg.base_url, '');
  const lastLink = [...main.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)].pop()?.[1] || '';
  if (!(lastLink === cfg.action.url || lastLink === actionAbs || lastLink === cfg.base_url + actionAbs)) p.push(`action: the page must end in the site's one action (${cfg.action.url})`);
  // Sourced facts; nothing invented.
  if (verifiedFacts.length < 1) p.push('facts: needs at least one fact whose source URL answered 200');
  // Only the sourced-facts block may carry numbers or named sources; and only
  // when each line in it is a verified fact.
  const factsBlock = (main.match(/<section[^>]+data-search-loop=["']facts["'][\s\S]*?<\/section>/i) || [''])[0];
  for (const li of factsBlock.match(/<li[\s>][\s\S]*?<\/li>/gi) || []) {
    const t = stripTags(li);
    if (!verifiedFacts.some((f) => t.includes(f.claim.slice(0, 40)))) p.push(`facts: "${t.slice(0, 60)}" has no verified source`);
  }
  const prose = stripTags(main.replace(factsBlock, ' '));
  void factText;
  for (const s of prose.split(/(?<=[.!?])\s+/)) {
    if (STAT.test(s) && !verifiedFacts.some((f) => s.includes(f.claim.slice(0, 40)))) { p.push(`invented: unsourced statistic "${s.slice(0, 80)}"`); break; }
  }
  if (REVIEW.test(prose)) p.push(`invented: review or testimonial language "${(prose.match(REVIEW) || [])[0]}"`);
  if (CREDENTIAL.test(prose)) p.push(`invented: credential or expert claim "${(prose.match(CREDENTIAL) || [])[0]}"`);
  if (PERSON_QUOTE.test(prose)) p.push(`invented: a named person or quote "${(prose.match(PERSON_QUOTE) || [])[0].slice(0, 60)}"`);
  if (PLACEHOLDER.test(text)) p.push(`unfinished: placeholder or leaked model text "${(text.match(PLACEHOLDER) || [])[0]}"`);
  if (FILLER.test(text)) notes.push(`filler phrase: "${(text.match(FILLER) || [])[0]}"`);
  // Health / dental gate.
  if (cfg.health_gate && cfg.health_gate !== 'none') {
    const allowed = cfg.health?.real_facts || {};
    if (HEALTH.outcome.test(text)) p.push(`health: outcome or treatment claim "${text.match(HEALTH.outcome)[0]}"`);
    if (HEALTH.advice.test(text)) p.push(`health: medical advice "${text.match(HEALTH.advice)[0]}"`);
    if (!allowed.hours && HEALTH.hours.test(text)) p.push(`health: hours or availability not on record "${text.match(HEALTH.hours)[0]}"`);
    if (!(allowed.services || []).length && HEALTH.offer.test(text)) p.push(`health: service claim with no services on record "${text.match(HEALTH.offer)[0]}"`);
  }
  // Near-duplicate.
  const sh = shingles(text);
  for (const other of [...(ctx.corpus || []), ...(ctx.siblings || [])]) {
    if (other.route === ctx.selfRoute || !other.sh) continue;
    const j = jaccard(sh, other.sh);
    if (j >= LIMITS.nearDup) { p.push(`near-duplicate of ${other.route} (similarity ${j.toFixed(2)})`); break; }
  }
  return { problems: p, notes };
}
