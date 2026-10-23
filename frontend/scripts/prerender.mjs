// Static pre-rendering (SSG): every route becomes its own HTML file with the real content, <head> tags,
// JSON-LD and Ant Design CSS already in place - good for crawlers and for first paint.
// Also writes sitemap.xml, robots.txt and 404.html.
// Ant Design derives its CSS class hashes from NODE_ENV. The browser bundle is built for production, so the
// server render must use the same mode or the pre-rendered markup would carry class names that match no CSS.
process.env.NODE_ENV = 'production';

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const serverEntry = path.join(root, 'dist-server', 'entry-server.js');
const { render, routes, SITE_URL, pathFor, LANGS } = await import(pathToFileURL(serverEntry).href);

const template = readFileSync(path.join(dist, 'index.html'), 'utf8');

function inject({ html, styles, headTags, lang, dir }) {
  return template
    .replace(/<html[^>]*>/, `<html lang="${lang}" dir="${dir}">`)
    .replace('<!--head-tags-->', () => headTags)
    .replace('<!--app-styles-->', () => styles)
    .replace('<!--app-html-->', () => html);
}

function write(url, content) {
  const file = url.endsWith('/') ? path.join(dist, url, 'index.html') : path.join(dist, url);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

for (const r of routes()) {
  write(r.url, inject(render(r.url)));
  console.log('prerendered', r.url);
}

// 404 page (served with status 404 by the server; noindex)
write('/404.html', inject(render('/__not-found__/')));

// sitemap with hreflang alternates
const today = new Date().toISOString().slice(0, 10);
const urls = routes()
  .map((r) => {
    const alts = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE_URL}${pathFor(l, r.key)}"/>`).join('\n');
    const xdef = `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}${pathFor('ar', r.key)}"/>`;
    let priority = '0.8';
    if (r.key === 'home') priority = '1.0';
    else if (r.key === 'privacy') priority = '0.3';
    return `  <url>\n    <loc>${SITE_URL}${r.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n${alts}\n${xdef}\n  </url>`;
  })
  .join('\n');
writeFileSync(
  path.join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`,
);
writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

rmSync(path.join(root, 'dist-server'), { recursive: true, force: true });
console.log('done:', routes().length, 'pages + sitemap.xml, robots.txt, 404.html');
