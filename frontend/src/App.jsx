import { Routes, Route, useLocation } from 'react-router-dom';
import { I18nProvider, PAGES, LANGS, DEFAULT_LANG, parseLocation } from './i18n/index.jsx';
import { AppConfig } from './components/Theme.jsx';
import Landing from './pages/Landing.jsx';
import NotFound from './pages/NotFound.jsx';

/**
 * URL scheme (every page is pre-rendered to static HTML for SEO):
 *   Arabic (default)  /            /pdf-to-word/   /arabic-pdf-to-word/   /scanned-pdf-to-word/   /privacy/
 *   English           /en/         /en/pdf-to-word/ ...
 */
export default function App() {
  const { pathname } = useLocation();
  const { lang } = parseLocation(pathname);
  return (
    <I18nProvider lang={lang}>
      <AppConfig>
        <Routes>
          {LANGS.flatMap((l) =>
            PAGES.map((p) => {
              const base = l === DEFAULT_LANG ? '' : `/${l}`;
              const path = p.slug ? `${base}/${p.slug}` : base || '/';
              return <Route key={`${l}-${p.key}`} path={path} element={<Landing pageKey={p.key} />} />;
            }),
          )}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppConfig>
    </I18nProvider>
  );
}
