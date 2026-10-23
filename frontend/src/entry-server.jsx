import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { createCache, extractStyle, StyleProvider } from '@ant-design/cssinjs';
import App from './App.jsx';
import { buildHead, renderHeadTags } from './lib/seo.js';
import { parseLocation, PAGES, LANGS, pathFor, SITE_URL } from './i18n/index.jsx';

/** Render one URL to static HTML + head tags + Ant Design CSS (used by scripts/prerender.mjs). */
export function render(url) {
  const cache = createCache();
  const html = renderToString(
    <StyleProvider cache={cache} layer>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StyleProvider>,
  );
  const { lang, page } = parseLocation(url);
  const head = buildHead(page ? { lang, pageKey: page } : { lang, notFound: true });
  return { html, styles: extractStyle(cache), headTags: renderHeadTags(head), lang: head.lang, dir: head.dir };
}

export const routes = () => LANGS.flatMap((l) => PAGES.map((p) => ({ url: pathFor(l, p.key), lang: l, key: p.key })));
export { SITE_URL, pathFor, LANGS, PAGES };
