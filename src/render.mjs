// Page HTML from a draft. One renderer; the gate reads what it writes.
import { esc, norm } from './util.mjs';
import { LIMITS } from './gate.mjs';

const TITLE_SEP = ' — ';
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = (x) => x.replace(/\s+/g, ' ').replace(/^[\s—|:,;-]+|[\s—|:,;-]+$/g, '').trim();

// Cut at a word boundary to at most n characters (never mid-word, never padded).
function cutWords(x, n) {
  if (x.length <= n) return x;
  return tidy(x.slice(0, n + 1).replace(/\s+\S*$/, '')) || x.slice(0, n);
}

// The title the page carries: "<search first> — <site name>", the site name
// exactly once, fitted to the 30-65 band. The model's lead is cleaned of the
// site name; a lead too short to make 30 falls back to the H1; a title over 65
// has its lead cut at a word boundary. The gate only notes what is left over.
export function fitTitle(cfg, draft) {
  const name = cfg.site_name;
  const strip = (x) => tidy(String(x || '').replace(new RegExp(reEsc(name), 'gi'), ' '));
  const room = LIMITS.title[1] - name.length - TITLE_SEP.length;
  let lead = strip(draft.title_lead);
  const h1 = strip(draft.h1);
  if ((lead + TITLE_SEP + name).length < LIMITS.title[0] && h1.length > lead.length) lead = h1;
  if (!lead) lead = h1 || name;
  if (lead.length > room && room >= 15) lead = cutWords(lead, room);
  return lead + TITLE_SEP + name;
}

// A meta description over the limit is cut at a word boundary (never padded).
// Words a shortened description must never end on ("... for your.").
export const DANGLING = new Set('a an the and or but nor so yet for of to in on at by with from into onto upon about as than that which who whom whose what when where while if because your you my our their his her its this these those is are was were be been being has have had do does did can could will would should may might must not no very more most less just also each every any some such how why'.split(' '));

// Over the limit: cut at a sentence end, else a clause boundary, else a word
// boundary with no trailing function word, always within [min, max].
export function fitMeta(m) {
  const s = String(m || '').trim();
  const [min, max] = LIMITS.meta;
  if (s.length <= max) return s;
  const win = s.slice(0, max);
  const ok = (t) => t.length >= min && t.length <= max;
  const sentence = [...win.matchAll(/[.!?](?=\s|$)/g)].map((x) => win.slice(0, x.index + 1)).reverse().find(ok);
  if (sentence) return sentence;
  const tidy = (t) => {
    const words = t.replace(/[,;:\-\u2013\u2014\s]+$/, '').split(/\s+/);
    while (words.length && DANGLING.has(words[words.length - 1].toLowerCase().replace(/[^a-z']/g, ''))) words.pop();
    return words.join(' ').replace(/[,;:\-\u2013\u2014\s]+$/, '');
  };
  const clause = [...win.matchAll(/\s*[,;:\u2013\u2014](?=\s)/g)].map((x) => tidy(win.slice(0, x.index)) + '.').reverse().find(ok);
  if (clause) return clause;
  const word = tidy(s.slice(0, max - 1).replace(/\s+\S*$/, '')) + '.';
  return ok(word) ? word : s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const humanDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${day} ${MONTHS[m - 1]} ${y}`; };

export function pageUrl(cfg, slug) {
  return cfg.base_url + cfg.output.url_prefix + slug + (cfg.output.format === 'dir-index' ? '/' : '');
}
export function pageRel(cfg, slug) {
  const dir = cfg.output.dir.replace(/\/$/, '');
  return cfg.output.format === 'dir-index' ? `${dir}/${slug}/index.html` : `${dir}/${slug}.html`;
}

export const RELATED_START = '<!-- search-loop:related -->';
export const RELATED_END = '<!-- /search-loop:related -->';

// The page's Organization: name and url always; logo and sameAs when the site's
// config gives them (Search Readiness c1 reads the first Organization node and
// wants name, url, logo and sameAs). Never invented: absent in config, absent here.
export function publisherNode(cfg) {
  const p = cfg.publisher || {};
  const sameAs = (Array.isArray(p.sameAs) ? p.sameAs : []).filter((u) => typeof u === 'string' && u);
  return { '@type': 'Organization', name: p.name || cfg.site_name, url: p.url || cfg.base_url, ...(p.logo ? { logo: p.logo } : {}), ...(sameAs.length ? { sameAs } : {}) };
}

// v1.13.0: the sourced facts are written by the model as reader-useful lines under its own
// heading (p-n-p #223 review sr_mwrbmeq6vzb3: a fixed "What the sources say" over town trivia
// read as machine-made). The source link is kept small after each line.
function factsBlock(heading, facts) {
  return `<section data-search-loop="facts"><h2>${esc(heading)}</h2><ul>${facts.map((f) => `<li>${esc(f.claim)} <small>(<a href="${esc(f.source_url)}" rel="noopener">${esc(f.source_name || new URL(f.source_url).hostname)}</a>)</small></li>`).join('')}</ul></section>`;
}

// draft: { h1, title_lead, meta_description, direct_answer, sections[{heading, paragraphs[], bullets?[]}], faq[{q,a}], facts_heading, facts[{claim, source_url, source_name, verified}] }
// v1.14.1: a web address on the site's own host written in the prose is a link. keepmyproof's voice
// says "Link the vault hub https://keepmyproof.com/vault and the disclaimer ..."; the model writes the
// address as text, and render escaped it, so the page showed it bare (what-documentation-is-needed-
// for-a-divorce, 22 Nov 2026). The address stays the link's text, so draftDrift reads the same words.
// Only addresses the gate allows (allowed_link_targets) on the site's host; any other stays text.
// Prose fields are plain text, so nothing here is already inside a link.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\[\]]+/g;
const bare = (h) => h.toLowerCase().replace(/^www\./, '');
export function prose(cfg, text) {
  const s = String(text ?? '');
  const site = new URL(cfg.base_url);
  let out = ''; let at = 0;
  for (const m of s.matchAll(URL_IN_TEXT)) {
    const addr = m[0].replace(/[.,;:!?]+$/, '');
    let u; try { u = new URL(addr); } catch { continue; }
    if (u.username || u.password || bare(u.hostname) !== bare(site.hostname) || u.port !== site.port) continue;
    if (!(cfg.allowed_link_targets || []).some((t) => addr.startsWith(t))) continue;
    out += `${esc(s.slice(at, m.index))}<a href="${esc(addr)}">${esc(addr)}</a>`;
    at = m.index + addr.length;
  }
  return out + esc(s.slice(at));
}

// The site's one action, as every page ends. CHECK swaps it into live pages when the config's
// action changes (f9: weddingchecklistpdf.com kept the old $9 link after 7 Nov 2026).
export function actionLine(cfg) {
  return `<p class="site-action"><a class="button" href="${esc(cfg.action.url)}">${esc(cfg.action.label)}</a></p>`;
}

export function render(cfg, { slug, draft, related = [], published, modified }) {
  const url = pageUrl(cfg, slug);
  const title = fitTitle(cfg, draft);
  draft = { ...draft, meta_description: fitMeta(draft.meta_description) };
  const t = cfg.template || {};
  const og = t.og_image || { url: `${cfg.base_url}/og.png`, width: 1200, height: 630 };
  const facts = (draft.facts || []).filter((f) => f.verified);
  const graph = [
    { '@type': 'Article', '@id': `${url}#article`, headline: draft.h1, description: draft.meta_description, url, mainEntityOfPage: url, datePublished: published, dateModified: modified || published, inLanguage: 'en',
      author: cfg.author?.name ? { '@type': 'Person', name: cfg.author.name, ...(cfg.author.url ? { url: cfg.author.url } : {}) } : publisherNode(cfg),
      publisher: publisherNode(cfg),
      ...(facts.length ? { citation: facts.map((f) => f.source_url) } : {}) },
    { '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: draft.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: cfg.site_name, item: cfg.base_url + '/' },
      { '@type': 'ListItem', position: 2, name: t.section_name || 'Questions', item: cfg.base_url + cfg.output.url_prefix },
      { '@type': 'ListItem', position: 3, name: draft.h1, item: url },
    ] },
  ];
  // v1.7.1: a how-to page gives its steps as a numbered list (page shape d2: "a how-to without
  // numbered steps" failed p-n-p's /questions/how-to-book-birthday-party on 7 Nov 2026).
  const list = /\bhow to\b/i.test(`${title} ${draft.h1}`) ? 'ol' : 'ul';
  const styles = (t.stylesheets || []).map((h) => `<link href="${esc(h)}" rel="stylesheet"/>`).join('');
  const body = [
    `<nav aria-label="Breadcrumb" class="breadcrumb"><a href="/">${esc(cfg.site_name)}</a> › <span>${esc(draft.h1)}</span></nav>`,
    `<h1>${esc(draft.h1)}</h1>`,
    `<p class="direct-answer">${prose(cfg, draft.direct_answer)}</p>`,
    `<p class="page-dates">Published <time datetime="${published}">${humanDate(published)}</time>${modified && modified !== published ? ` · Updated <time datetime="${modified}">${humanDate(modified)}</time>` : ''} · ${cfg.author?.name ? `By ${cfg.author.url ? `<a href="${esc(cfg.author.url)}">${esc(cfg.author.name)}</a>` : esc(cfg.author.name)}` : esc(cfg.publisher?.name || cfg.site_name)}</p>`,
    ...draft.sections.map((s) => `<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map((x) => `<p>${prose(cfg, x)}</p>`).join('')}${(s.bullets || []).length ? `<${list}>${s.bullets.map((b) => `<li>${prose(cfg, b)}</li>`).join('')}</${list}>` : ''}${s.table ? tableHtml(s.table) : ''}</section>`),
    ...(facts.length && draft.facts_heading ? [factsBlock(draft.facts_heading, facts)] : []),
    `<section class="faq"><h2>Frequently asked questions</h2>${draft.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${prose(cfg, f.a)}</p>`).join('')}</section>`,
    // v1.13.0: a draft with no model-written heading (older drafts) keeps its sources, below the
    // FAQ under a plain label, so no fixed heading sits in the middle of the page.
    ...(facts.length && !draft.facts_heading ? [factsBlock('Sources', facts)] : []),
    related.length ? `<section data-search-loop="related"><h2>Related questions</h2><ul>${related.map((r) => `<li><a href="${esc(r.route)}">${esc(r.anchor)}</a></li>`).join('')}</ul></section>` : '',
    actionLine(cfg),
  ].join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta content="width=device-width,initial-scale=1" name="viewport"/>
<title>${esc(title)}</title>
<meta content="${esc(draft.meta_description)}" name="description"/>
<meta content="index,follow" name="robots"/><link href="${url}" rel="canonical"/>
<meta content="${esc(title)}" property="og:title"/><meta content="${esc(draft.meta_description)}" property="og:description"/><meta content="article" property="og:type"/><meta content="${url}" property="og:url"/><meta content="${esc(cfg.site_name)}" property="og:site_name"/><meta content="${esc(og.url)}" property="og:image"/><meta content="${og.width}" property="og:image:width"/><meta content="${og.height}" property="og:image:height"/>
<meta content="summary_large_image" name="twitter:card"/><meta content="${esc(title)}" name="twitter:title"/><meta content="${esc(draft.meta_description)}" name="twitter:description"/><meta content="${esc(og.url)}" name="twitter:image"/>
<meta content="search-loop" name="generator"/>
${styles}
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>
</head><body>
${t.header_html || `<header class="site-header"><a href="/">${esc(cfg.site_name)}</a></header>`}
<main><article class="search-loop-page">
${body}
</article></main>
${t.footer_html || ''}
</body></html>
`;
}

// Insert or extend the "Related questions" block on an existing page.
export function withRelatedLink(html, { route, anchor }, max = 6) {
  const li = `<li><a href="${esc(route)}">${esc(anchor)}</a></li>`;
  if (html.includes(`href="${route}"`)) return html;
  const re = new RegExp(`${RELATED_START}[\\s\\S]*?${RELATED_END}`);
  const m = html.match(re);
  if (m) {
    const items = m[0].match(/<li>[\s\S]*?<\/li>/g) || [];
    if (items.length >= max) return html;
    return html.replace(m[0], m[0].replace('</ul>', `${li}</ul>`));
  }
  const block = `${RELATED_START}<section class="search-loop-related"><h2>Related questions</h2><ul>${li}</ul></section>${RELATED_END}`;
  for (const anchorTag of ['</article>', '</main>', '</body>']) {
    const i = html.lastIndexOf(anchorTag);
    if (i >= 0) return html.slice(0, i) + block + html.slice(i);
  }
  return null;
}

// The "Related questions" links on a live page, in either form the engine writes: render()'s
// <section data-search-loop="related"> and withRelatedLink()'s marked block. Every re-render
// carries them over (v1.14.0: the marked block was dropped by strengthen, refresh and reshape).
export function relatedLinksOf(html) {
  const blocks = [...html.matchAll(/<section data-search-loop="related">[\s\S]*?<\/section>/g), ...html.matchAll(new RegExp(`${reEsc(RELATED_START)}[\\s\\S]*?${reEsc(RELATED_END)}`, 'g'))];
  const seen = new Set();
  return blocks.flatMap((m) => [...m[0].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]).map((x) => ({ route: unesc(x[1]), anchor: unesc(x[2]) })).filter((r) => !seen.has(r.route) && seen.add(r.route));
}

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', hellip: '\u2026', amp: '&' };
const unesc = (x) => x.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : NAMED[n.toLowerCase()] ?? m));
const textOf = (h) => norm(unesc(h.replace(/<[^>]+>/g, ' ')));
// v1.16.0: a section's comparison table (cleanDraft keeps only a real grid).
export const tableHtml = (t) => `<div class="table-scroll" style="overflow-x:auto"><table><thead><tr>${t.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;

const TEMPLATE_HEADINGS = new Set(['Frequently asked questions', 'Related questions'].map(norm));

export const EDITED_PAGE = 'the page was edited after its draft was saved, so a re-render would undo that edit; left as it is';

// v1.14.0: the live page's words that its saved draft no longer matches. A re-render from the
// draft (strengthen, refresh, reshape) would silently undo a hand fix made to the page (a
// keepmyproof legal trip-wire fix, 14 Nov 2026, was in the page and not the draft), so any
// difference here means the page is left as it is. Compares the draft's own prose (H1, lead,
// section headings, paragraphs and bullets, FAQ) with the page's H1, lead and <section>s, as
// words only: layout, dates, sources and related links are not compared.
// Returns [] when they match, else up to 3 short descriptions of what differs.
export function draftDrift(html, draft) {
  const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (!m) return ['the page has no <article> to compare with its draft'];
  const art = m[1].replace(new RegExp(`${reEsc(RELATED_START)}[\\s\\S]*?${reEsc(RELATED_END)}`, 'g'), '');
  const blocks = (h) => [...h.matchAll(/<(h1|h2|h3|p|li|th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((x) => textOf(x[2])).filter(Boolean);
  const sections = [...art.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)].filter((x) => !/data-search-loop="(?:facts|related)"|search-loop-related/.test(x[1])).flatMap((x) => blocks(x[2]));
  const top = [...art.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>|<p class="direct-answer">([\s\S]*?)<\/p>/gi)].map((x) => textOf(x[1] ?? x[2]));
  const live = [...top, ...sections].filter((x) => !TEMPLATE_HEADINGS.has(x));
  const own = [draft.h1, draft.direct_answer, ...(draft.sections || []).flatMap((s) => [s.heading, ...(s.paragraphs || []), ...(s.bullets || []), ...(s.table ? [...s.table.columns, ...s.table.rows.flat()] : [])]), ...(draft.faq || []).flatMap((f) => [f.q, f.a])]
    .map((x) => textOf(esc(x))).filter(Boolean);
  const ownSet = new Set(own); const liveSet = new Set(live);
  const cut = (x) => (x.length > 70 ? `${x.slice(0, 70)}...` : x);
  return [
    ...own.filter((x) => !liveSet.has(x)).map((x) => `the draft says "${cut(x)}", the page does not`),
    ...live.filter((x) => !ownSet.has(x)).map((x) => `the page says "${cut(x)}", the draft does not`),
  ].slice(0, 3);
}

export function withoutRelatedLink(html, route) {
  const re = new RegExp(`<li><a href="${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">[\\s\\S]*?</a></li>`);
  let out = html.replace(re, '');
  out = out.replace(new RegExp(`${RELATED_START}<section class="search-loop-related"><h2>Related questions</h2><ul></ul></section>${RELATED_END}`), '');
  return out;
}
