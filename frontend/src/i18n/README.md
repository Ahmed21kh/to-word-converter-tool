# frontend/src/i18n

Small built-in localisation (no library). The language comes from the URL: `/…` is Arabic (default), `/en/…` is English.

| File | Purpose |
| --- | --- |
| `index.jsx` | `I18nProvider` / `useI18n()` (`t('a.b.c', { vars })`), the list of pages, `pathFor(lang, page)` and `parseLocation()` for URLs, `SITE_URL`. |
| `ar.js` | Arabic dictionary (default): UI strings, SEO titles/descriptions, landing copy, FAQ. |
| `en.js` | English dictionary (same keys as `ar.js`). |

To add a language: copy `en.js`, translate it, register it in `index.jsx` (`DICTS`) - routes, hreflang and the sitemap follow automatically.
To add a page: add it to `PAGES` and give it an entry under `pages` in each dictionary.
