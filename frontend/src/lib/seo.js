// Head management without a runtime dependency:
//  - buildHead()      pure function -> list of head entries (used by the pre-renderer and the client)
//  - renderHeadTags() serialises entries to HTML for the static files
//  - applyHead()      updates document.head on client-side navigation
import { DICTS, LANGS, DEFAULT_LANG, PAGES, SITE_URL, pathFor } from '../i18n/index.jsx';

const abs = (p) => `${SITE_URL}${p}`;
const OG_IMAGE = abs('/og-image.png');

function structuredData({ lang, pageKey, dict, page, url }) {
  const items = dict.faq.items.map((f) => ({
    '@type': 'Question',
    name: f.q.replace('{size}', '500'),
    acceptedAnswer: { '@type': 'Answer', text: f.a.replace('{size}', '500') },
  }));
  const graph = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: dict.appName,
      url,
      description: page.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Any (web browser)',
      browserRequirements: 'Requires JavaScript',
      inLanguage: LANGS,
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: dict.features.items.map((f) => f.title),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: dict.nav.home, item: abs(pathFor(lang, 'home')) },
        ...(pageKey === 'home' ? [] : [{ '@type': 'ListItem', position: 2, name: dict.nav[pageKey] || page.h1, item: url }]),
      ],
    },
  ];
  if (pageKey !== 'privacy') graph.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items });
  return graph;
}

export function buildHead({ lang, pageKey = 'home', notFound = false }) {
  const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
  if (notFound) {
    return {
      lang: dict.meta.lang,
      dir: dict.meta.dir,
      entries: [
        { tag: 'title', text: `${dict.notFound.title} – ${dict.appName}` },
        { tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } },
      ],
    };
  }
  const page = dict.pages[pageKey];
  const path = pathFor(lang, pageKey);
  const url = abs(path);
  const entries = [
    { tag: 'title', text: page.title },
    { tag: 'meta', attrs: { name: 'description', content: page.description } },
    { tag: 'meta', attrs: { name: 'keywords', content: page.keywords } },
    { tag: 'meta', attrs: { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' } },
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
    ...LANGS.map((l) => ({ tag: 'link', attrs: { rel: 'alternate', hreflang: l, href: abs(pathFor(l, pageKey)) } })),
    { tag: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: abs(pathFor(DEFAULT_LANG, pageKey)) } },
    { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
    { tag: 'meta', attrs: { property: 'og:site_name', content: dict.appName } },
    { tag: 'meta', attrs: { property: 'og:title', content: page.title } },
    { tag: 'meta', attrs: { property: 'og:description', content: page.description } },
    { tag: 'meta', attrs: { property: 'og:url', content: url } },
    { tag: 'meta', attrs: { property: 'og:locale', content: dict.meta.og } },
    ...LANGS.filter((l) => l !== lang).map((l) => ({ tag: 'meta', attrs: { property: 'og:locale:alternate', content: DICTS[l].meta.og } })),
    { tag: 'meta', attrs: { property: 'og:image', content: OG_IMAGE } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
    { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
    { tag: 'meta', attrs: { name: 'twitter:title', content: page.title } },
    { tag: 'meta', attrs: { name: 'twitter:description', content: page.description } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: OG_IMAGE } },
    ...structuredData({ lang, pageKey, dict, page, url }).map((obj) => ({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      text: JSON.stringify(obj),
    })),
  ];
  return { lang: dict.meta.lang, dir: dict.meta.dir, entries };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrString = (attrs = {}) => Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

export function renderHeadTags(head) {
  return head.entries
    .map((e) => {
      if (e.tag === 'title') return `<title data-seo>${esc(e.text)}</title>`;
      if (e.tag === 'script') return `<script data-seo${attrString(e.attrs)}>${e.text.replace(/</g, '\\u003c')}</script>`;
      return `<${e.tag} data-seo${attrString(e.attrs)}>`;
    })
    .join('\n    ');
}

/** Client-side: swap the SEO tags when the route or language changes. */
export function applyHead(head) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = head.lang;
  document.documentElement.dir = head.dir;
  document.querySelectorAll('[data-seo]').forEach((n) => n.remove());
  for (const e of head.entries) {
    if (e.tag === 'title') {
      document.title = e.text;
      continue;
    }
    const el = document.createElement(e.tag);
    el.setAttribute('data-seo', '');
    for (const [k, v] of Object.entries(e.attrs || {})) el.setAttribute(k, v);
    if (e.text) el.textContent = e.text;
    document.head.appendChild(el);
  }
}

export { PAGES };
