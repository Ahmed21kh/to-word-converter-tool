import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from 'antd';
import { useI18n, pathFor } from '../i18n/index.jsx';
import { applyHead, buildHead } from '../lib/seo.js';
import { Header, Footer } from '../components/Layout.jsx';

export default function NotFound() {
  const { lang, t } = useI18n();
  useEffect(() => {
    applyHead(buildHead({ lang, notFound: true }));
  }, [lang]);
  return (
    <>
      <Header pageKey="home" />
      <main className="mx-auto max-w-xl px-4 py-24 text-center">
        <p className="mb-2 text-6xl font-extrabold text-brand-600">404</p>
        <h1 className="mb-3 text-3xl font-extrabold">{t('notFound.title')}</h1>
        <p className="mb-8 text-slate-600 dark:text-slate-400">{t('notFound.text')}</p>
        <Link to={pathFor(lang, 'home')}><Button type="primary" size="large">{t('notFound.back')}</Button></Link>
      </main>
      <Footer />
    </>
  );
}
