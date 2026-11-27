// The site's own product, as it really is today (v1.17.0). A site that sets `product.facts`
// (and optionally `product.lacks`) has every new page and every strengthen read by a free model
// against them before it is written: any sentence that says or implies the product does, has,
// costs or offers something the facts do not support stops the page (the fix pass is told
// which sentence). Meaning is read by a model, never a keyword list. A check that cannot be
// read (no free model, an answer that is not the JSON asked for, or one that lists no claim on
// a page that names the product) is "not read": the page is not written this run and the
// search stays queued. It is never treated as a pass.
import { parseJsonAnswer } from './llm.mjs';

export const hasProduct = (cfg) => Array.isArray(cfg.product?.facts) && cfg.product.facts.length > 0;
// The product's own name when it differs from the site's (weddingchecklistpdf.com sells Dream Wedding Builder).
export const productName = (cfg) => cfg.product?.name || cfg.site_name;

export function checkProduct(c) {
  if (c.product === undefined) return [];
  const p = [];
  const list = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim().length >= 8 && s.length <= 400);
  if (!list(c.product?.facts) || !c.product.facts.length || c.product.facts.length > 40) p.push('product.facts: 1-40 plain sentences, each true of the product today (what it is, does, costs, where it runs, whether it is out yet)');
  if (c.product?.name !== undefined && !(typeof c.product.name === 'string' && c.product.name.trim().length >= 2 && c.product.name.length <= 60)) p.push('product.name: the product\'s own name, when it is not site_name');
  if (c.product?.lacks !== undefined && !(list(c.product.lacks) && c.product.lacks.length <= 40)) p.push('product.lacks: up to 40 plain sentences naming what the product does NOT do (so a page never claims it)');
  return p;
}

// What the writer is told about the product.
export function productBrief(cfg) {
  if (!hasProduct(cfg)) return '';
  const name = productName(cfg);
  const lacks = cfg.product.lacks?.length ? `\nWhat ${name} does NOT do or have (never say or imply it does): ${cfg.product.lacks.map((s) => `\n- ${s}`).join('')}` : '';
  return `\nWhat ${name} is today. These are the ONLY things the page may say about ${name} (what it does, has, costs, where it runs, whether it is available): ${cfg.product.facts.map((s) => `\n- ${s}`).join('')}${lacks}\nNever add a feature, platform, price or promise for ${name} that is not in that list. When the search asks for something ${name} does not do, say so plainly.`;
}

// The page's own words (never the site's header, footer or action line, which come from the config).
export function draftText(d) {
  return [d.h1, d.direct_answer, ...(d.sections || []).flatMap((s) => [s.heading, ...(s.paragraphs || []), ...(s.bullets || []), ...(s.table ? [s.table.columns.join(' | '), ...s.table.rows.map((r) => r.join(' | '))] : [])]), ...(d.faq || []).flatMap((f) => [f.q, f.a]), ...(d.facts || []).map((f) => f.claim)].filter(Boolean).join('\n');
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const namesProduct = (cfg, text) => [productName(cfg), cfg.site_name, cfg.site_words].filter(Boolean).some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(n)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));

// Returns {ok:true, problems:[...]} (problems empty = every claim about the product is supported)
// or {ok:false, notRead:'<reason>'}.
export async function productClaims(cfg, draft, { chat, fetchImpl }) {
  if (!hasProduct(cfg)) return { ok: true, problems: [] };
  const text = draftText(draft);
  const name = productName(cfg);
  const r = await chat({ cfg, fetchImpl, maxTokens: 1200, messages: [
    { role: 'system', content: 'You check one web page against the facts about one product. Return ONLY JSON.' },
    { role: 'user', content: `Product: ${name}.\nTrue facts about it today:${cfg.product.facts.map((s, i) => `\n${i + 1}. ${s}`).join('')}${cfg.product.lacks?.length ? `\nIt does NOT do or have:${cfg.product.lacks.map((s) => `\n- ${s}`).join('')}` : ''}\n\nPage text:\n${text}\n\nList EVERY sentence in the page text that says or implies something about ${name} itself (what it does, has, keeps, costs, where it runs, who it is for, whether it is out yet). For each, say whether the true facts above support it. A sentence that gives ${name} a feature, platform, price, availability or promise the facts do not state is NOT supported, and so is one the "does NOT" list contradicts. Sentences only about other products or general advice are not listed.\nReturn {"claims":[{"sentence":"...","supported":true|false,"why":"which fact supports it, or what it adds"}]}` },
  ] });
  if (!r.ok) return { ok: false, notRead: `product-claim check: no free model answered (${r.reason})` };
  const j = parseJsonAnswer(r.answer);
  if (!Array.isArray(j?.claims) || j.claims.some((c) => typeof c?.sentence !== 'string' || typeof c?.supported !== 'boolean')) return { ok: false, notRead: 'product-claim check: the free model did not return {"claims":[{sentence, supported}]}' };
  // Only a sentence that is really on the page counts (v1.17.1): on the real free models a "good"
  // page came back with invented sentences built from the "does NOT" list, marked unsupported.
  const flat = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const page = flat(text);
  const onPage = j.claims.filter((c) => flat(c.sentence) && page.includes(flat(c.sentence)));
  // A page that names the product always says something about it; no sentence from the page there is a model that did not read.
  if (!onPage.length && namesProduct(cfg, text)) return { ok: false, notRead: `product-claim check: the model listed no sentence from the page, but the page names ${name}` };
  const bad = onPage.filter((c) => !c.supported);
  return { ok: true, problems: bad.slice(0, 4).map((c) => `product claim: "${c.sentence.slice(0, 160)}" is not in the site's product facts (${String(c.why || 'unsupported').slice(0, 120)}); say only what product.facts says about ${name}`) };
}
