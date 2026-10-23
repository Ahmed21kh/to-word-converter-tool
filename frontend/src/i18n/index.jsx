import { createContext, useContext, useMemo } from 'react';
import ar from './ar.js';
import en from './en.js';

export const DICTS = { ar, en };
export const DEFAULT_LANG = 'ar';
export const LANGS = Object.keys(DICTS);

/** Pages that exist in every language (each one is pre-rendered as its own static HTML file). */
export const PAGES = [
  { key: 'home', slug: '' },
  { key: 'pdfToWord', slug: 'pdf-to-word' },
  { key: 'arabicPdf', slug: 'arabic-pdf-to-word' },
  { key: 'ocr', slug: 'scanned-pdf-to-word' },
  { key: 'privacy', slug: 'privacy' },
];

export const SITE_URL = (import.meta.env.VITE_SITE_URL || 'https://pdf2word.example.com').replace(/\/$/, '');

/** Arabic (default) lives at the site root, English under /en/. Trailing slashes everywhere. */
export function pathFor(lang, pageKey = 'home') {
  const page = PAGES.find((p) => p.key === pageKey) || PAGES[0];
  const base = lang === 'ar' ? '/' : `/${lang}/`;
  return page.slug ? `${base}${page.slug}/` : base;
}

export function parseLocation(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const lang = LANGS.includes(parts[0]) && parts[0] !== DEFAULT_LANG ? parts.shift() : DEFAULT_LANG;
  const slug = parts.join('/');
  const page = PAGES.find((p) => p.slug === slug);
  return { lang, page: page ? page.key : null };
}

const lookup = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const interpolate = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

const I18nContext = createContext({ lang: DEFAULT_LANG, dict: ar, t: (k) => k, raw: () => undefined, dir: 'rtl' });

export function I18nProvider({ lang, children }) {
  const value = useMemo(() => {
    const dict = DICTS[lang] || ar;
    const raw = (key) => lookup(dict, key);
    const t = (key, vars) => {
      const v = raw(key);
      return typeof v === 'string' ? interpolate(v, vars) : key;
    };
    return { lang, dict, t, raw, dir: dict.meta.dir };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
