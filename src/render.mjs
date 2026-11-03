// Page HTML from a draft. One renderer; the gate reads what it writes.
import { esc } from './util.mjs';
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
export function fitMeta(m) {
  const s = String(m || '').trim();
  if (s.length <= LIMITS.meta[1]) return s;
  const cut = s.slice(0, LIMITS.meta[1] - 1).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '');
  return cut.length >= LIMITS.meta[0] ? cut + '.' : s;
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

// draft: { h1, title_lead, meta_description, direct_answer, sections[{heading, paragraphs[], bullets?[]}], faq[{q,a}], facts[{claim, source_url, source_name, verified}] }
export function render(cfg, { slug, draft, related = [], published, modified }) {
  const url = pageUrl(cfg, slug);
  const title = fitTitle(cfg, draft);
  draft = { ...draft, meta_description: fitMeta(draft.meta_description) };
  const t = cfg.template || {};
  const og = t.og_image || { url: `${cfg.base_url}/og.png`, width: 1200, height: 630 };
  const facts = (draft.facts || []).filter((f) => f.verified);
  const actionHref = cfg.action.url;
  const graph = [
    { '@type': 'Article', '@id': `${url}#article`, headline: draft.h1, description: draft.meta_description, url, mainEntityOfPage: url, datePublished: published, dateModified: modified || published, inLanguage: 'en',
      author: cfg.author?.name ? { '@type': 'Person', name: cfg.author.name, ...(cfg.author.url ? { url: cfg.author.url } : {}) } : { '@type': 'Organization', name: cfg.publisher?.name || cfg.site_name, url: cfg.publisher?.url || cfg.base_url },
      publisher: { '@type': 'Organization', name: cfg.publisher?.name || cfg.site_name, url: cfg.publisher?.url || cfg.base_url },
      ...(facts.length ? { citation: facts.map((f) => f.source_url) } : {}) },
    { '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: draft.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: cfg.site_name, item: cfg.base_url + '/' },
      { '@type': 'ListItem', position: 2, name: t.section_name || 'Questions', item: cfg.base_url + cfg.output.url_prefix },
      { '@type': 'ListItem', position: 3, name: draft.h1, item: url },
    ] },
  ];
  const styles = (t.stylesheets || []).map((h) => `<link href="${esc(h)}" rel="stylesheet"/>`).join('');
  const body = [
    `<nav aria-label="Breadcrumb" class="breadcrumb"><a href="/">${esc(cfg.site_name)}</a> › <span>${esc(draft.h1)}</span></nav>`,
    `<h1>${esc(draft.h1)}</h1>`,
    `<p class="direct-answer">${esc(draft.direct_answer)}</p>`,
    `<p class="page-dates">Published <time datetime="${published}">${humanDate(published)}</time>${modified && modified !== published ? ` · Updated <time datetime="${modified}">${humanDate(modified)}</time>` : ''} · ${cfg.author?.name ? `By ${cfg.author.url ? `<a href="${esc(cfg.author.url)}">${esc(cfg.author.name)}</a>` : esc(cfg.author.name)}` : esc(cfg.publisher?.name || cfg.site_name)}</p>`,
    ...draft.sections.map((s) => `<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map((x) => `<p>${esc(x)}</p>`).join('')}${(s.bullets || []).length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</section>`),
    facts.length ? `<section data-search-loop="facts"><h2>What the sources say</h2><ul>${facts.map((f) => `<li>${esc(f.claim)} (<a href="${esc(f.source_url)}" rel="noopener">${esc(f.source_name || new URL(f.source_url).hostname)}</a>)</li>`).join('')}</ul></section>` : '',
    `<section class="faq"><h2>Frequently asked questions</h2>${draft.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}</section>`,
    related.length ? `<section data-search-loop="related"><h2>Related questions</h2><ul>${related.map((r) => `<li><a href="${esc(r.route)}">${esc(r.anchor)}</a></li>`).join('')}</ul></section>` : '',
    `<p class="site-action"><a class="button" href="${esc(actionHref)}">${esc(cfg.action.label)}</a></p>`,
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

export function withoutRelatedLink(html, route) {
  const re = new RegExp(`<li><a href="${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">[\\s\\S]*?</a></li>`);
  let out = html.replace(re, '');
  out = out.replace(new RegExp(`${RELATED_START}<section class="search-loop-related"><h2>Related questions</h2><ul></ul></section>${RELATED_END}`), '');
  return out;
}
