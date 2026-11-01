// What the site already has: every HTML page's route, title, H1 and text.
// Used to skip searches a page already answers, to pick internal links, to
// place "Related questions" blocks and for the near-duplicate check.
import fs from 'node:fs';
import path from 'node:path';
import { walkHtml, stripTags, shingles } from './util.mjs';
import { isProtected } from './config.mjs';

export function routeFor(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

const pick = (re, s) => (s.match(re) || [])[1] || '';

export function readPage(root, rel) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const title = stripTags(pick(/<title[^>]*>([\s\S]*?)<\/title>/i, html));
  const h1 = stripTags(pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html));
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i, html) || pick(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i, html);
  const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html) || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]+name=["']robots["']/i.test(html);
  return { rel, route: routeFor(rel), title, h1, canonical, noindex, html };
}

export function buildIndex(cfg, { withText = false } = {}) {
  const root = cfg.root;
  const skip = [...(cfg.related?.skip_dirs || []), 'node_modules', 'dist', '.git'];
  const rels = new Set();
  for (const d of cfg.related?.scan_dirs || ['.']) for (const r of walkHtml(root, d, { skip })) rels.add(r);
  const pages = [];
  for (const rel of rels) {
    if (/(^|\/)(404|500)\.html$/.test(rel)) continue;
    let p;
    try { p = readPage(root, rel); } catch { continue; }
    if (p.noindex) continue;
    const entry = { rel, route: p.route, title: p.title, h1: p.h1, canonical: p.canonical, protected: isProtected(cfg, rel) };
    if (withText) { entry.text = stripTags(p.html.replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')); entry.sh = shingles(entry.text); }
    pages.push(entry);
  }
  return pages;
}
