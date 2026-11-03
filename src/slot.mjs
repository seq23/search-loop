// SLOT DRAFT (v1.3.1): write the material for one slot a site already has (an
// editorial-calendar entry with its own title and date) on the same free lanes
// and fix loop as BUILD, and hand it back. It never publishes, never writes a
// page, never touches the ledger: the site renders the draft into its own
// template and releases it on its own calendar.
//
// Why: a site with a client-approved calendar (Hicks, 3 Nov 2026) keeps its
// slots, titles and release time, but its queued bodies were template clones.
// The engine's writer replaces the bodies, slot for slot.
//
// slot = { title, question?, kind?, words?: [min, max], avoid?: { headings: [], phrases: [], sources: [] }, related?: [title] }
// draftSlot(cfg, slot, { chat, fetchImpl, check }) ->
//   { ok: true, draft, model, words, attempts } | { ok: false, stop, reason, problems? }
// `check(draft)` lets the site add its own blocking checks (copy/duplicate share
// against its live pages); its problems go back to the model on the next pass.
import { freeChat, parseJsonAnswer } from './llm.mjs';
import { cleanDraft, verifyFacts, MAX_ATTEMPTS } from './build.mjs';
import { LIMITS } from './gate.mjs';

export const SLOT_WORDS = { insight: [800, 1200], article: [1000, 1500], guide: [1500, 2200], 'white paper': [1800, 2500] };
const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll|my|me|mine|myself)\b/;
const wc = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

export function slotWords(slot) {
  const w = slot.words || SLOT_WORDS[slot.kind] || SLOT_WORDS.insight;
  return [Number(w[0]), Number(w[1])];
}

/** Every visible word the draft puts on the page: answer, sections, FAQ. */
export function draftWords(d) {
  return wc(d.direct_answer) + d.sections.reduce((n, s) => n + wc(s.heading) + s.paragraphs.reduce((m, p) => m + wc(p), 0), 0) + d.faq.reduce((n, f) => n + wc(f.q) + wc(f.a), 0);
}

export function slotPrompt(cfg, slot, problems) {
  const [min, max] = slotWords(slot);
  const nSections = Math.max(4, Math.min(8, Math.round(max / 220)));
  const avoid = slot.avoid || {};
  const facts = cfg.health?.real_facts ? `\nReal facts on record (use only these for services): ${JSON.stringify(cfg.health.real_facts)}` : '';
  return [
    { role: 'system', content: `You write one ${slot.kind || 'article'} for ${cfg.site_name} (${cfg.base_url}). Audience: ${cfg.audience}. Voice: ${cfg.voice}. You return ONLY a JSON object, no prose around it.` },
    { role: 'user', content: `Title (keep it; it was approved): "${slot.title}"
The real question this piece answers: "${slot.question || slot.title}"
Other pieces on the site you may mention by title (do not invent others): ${(slot.related || []).join(' | ') || 'none'}
The piece ends by inviting the reader to: ${cfg.action?.label || 'get in touch'}.${facts}

Return JSON with exactly these keys:
{
 "h1": "the approved title, unchanged",
 "meta_description": "${LIMITS.meta[0]}-${LIMITS.meta[1]} characters, the plain answer",
 "direct_answer": "${LIMITS.answer[0]}-${LIMITS.answer[1]} words that answer the question outright, first",
 "sections": [ {"heading": "a question a reader would ask about this exact topic, phrased as a question where natural", "paragraphs": ["90-160 words", "..."]} ],  // ${nSections} sections
 "faq": [ {"q": "a related question specific to this title", "a": "${LIMITS.faqAnswer[0]}-${LIMITS.faqAnswer[1]} words"} ],  // exactly 4
 "facts": [ {"claim": "one checkable fact in one sentence", "source_url": "https URL of a specific public page that states it (government, university, professional body, major publication)", "source_name": "publisher name"} ]  // 3-4, specific to this topic
}
The whole piece (answer, sections and FAQ) is ${min}-${max} words.
Hard rules: no statistics, percentages or "studies show" anywhere except inside "facts"; no named people, quotes, client stories, credentials, reviews or testimonials; never first person (no I, me, my): the writer never speaks as the therapist; no promises of outcomes; no diagnosis, treatment claims or medication advice; no filler; second person, short sentences; every heading and paragraph specific to this title, not reusable on a sibling piece.${(avoid.headings || []).length ? `\nNever use these headings (other pages already have them): ${avoid.headings.slice(0, 40).map((h) => `"${h}"`).join(', ')}` : ''}${(avoid.sources || []).length ? `\nDo not cite these pages (other pages already do): ${avoid.sources.slice(0, 20).join(', ')}` : ''}${(avoid.phrases || []).length ? `\nThese phrases already appear on other pages; never use them: ${avoid.phrases.slice(0, 40).map((p) => `"${p}"`).join(', ')}` : ''}${problems ? `\n\nYour previous draft failed these checks; fix every one:\n- ${problems.join('\n- ')}` : ''}` },
  ];
}

/** Blocking problems with a slot draft (before the site's own checks). */
export function slotProblems(d, slot) {
  const p = [];
  const [min, max] = slotWords(slot);
  const n = draftWords(d);
  if (n < min) p.push(`the piece is ${n} words; it must be ${min}-${max}`);
  if (n > max * 1.15) p.push(`the piece is ${n} words; it must be ${min}-${max}`);
  if (d.faq.length < 3) p.push(`the FAQ has ${d.faq.length} questions; it needs 4`);
  if (d.sections.length < 3) p.push(`only ${d.sections.length} sections`);
  const verified = d.facts.filter((f) => f.verified);
  if (verified.length < 2) p.push(`only ${verified.length} sources answered 200 when fetched; give 3-4 real, specific https pages`);
  const avoidSrc = new Set((slot.avoid?.sources || []).map(String));
  if (verified.length && verified.every((f) => avoidSrc.has(f.source_url))) p.push('every source is one other pages already cite; use sources specific to this topic');
  const text = [d.direct_answer, ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs]), ...d.faq.flatMap((f) => [f.q, f.a])].join(' \n ');
  if (FIRST_PERSON.test(text)) p.push('first person found (I, me, my); the writer never speaks as the therapist');
  if (/\[[^\]]*\]|lorem ipsum|TODO|insert /i.test(text)) p.push('placeholder text');
  const heads = new Set((slot.avoid?.headings || []).map((h) => h.toLowerCase().trim()));
  const reused = d.sections.map((s) => s.heading).filter((h) => heads.has(h.toLowerCase().trim()));
  if (reused.length) p.push(`headings already used on other pages: ${reused.join('; ')}`);
  return p;
}

export async function draftSlot(cfg, slot, { chat = freeChat, fetchImpl = fetch, check = null, attempts = MAX_ATTEMPTS } = {}) {
  if (!slot?.title) return { ok: false, stop: 'SLOT_INVALID', reason: 'a slot needs a title' };
  const [, max] = slotWords(slot);
  const maxTokens = Math.min(8000, Math.round(max * 2.2) + 1200);
  let problems = null; let last = null; let model = null;
  for (let i = 0; i < attempts; i++) {
    const r = await chat({ cfg, messages: slotPrompt(cfg, slot, problems), maxTokens, fetchImpl });
    if (!r.ok) return { ok: false, stop: r.stop || 'NO_FREE_MODEL', reason: r.reason, problems };
    model = r.model;
    const parsed = parseJsonAnswer(r.answer);
    if (parsed?.skip) return { ok: false, stop: 'SLOT_SKIPPED', reason: String(parsed.skip).slice(0, 200) };
    const d = cleanDraft(parsed);
    if (!d) { problems = ['the answer was not the JSON object asked for, with every key filled']; continue; }
    d.h1 = slot.title;
    d.facts = await verifyFacts(d.facts, fetchImpl);
    problems = slotProblems(d, slot);
    if (!problems.length && typeof check === 'function') problems = (await check(d)) || [];
    last = d;
    if (!problems.length) return { ok: true, draft: d, model, words: draftWords(d), attempts: i + 1 };
  }
  return { ok: false, stop: 'SLOT_DRAFT_REJECTED', reason: (problems || []).slice(0, 6).join('; '), problems, draft: last, model };
}
