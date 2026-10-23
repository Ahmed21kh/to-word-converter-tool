import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from 'antd';
import { useI18n, pathFor } from '../i18n/index.jsx';
import { applyHead, buildHead } from '../lib/seo.js';
import { Header, Footer } from '../components/Layout.jsx';
import { Hero, Article, Features, HowItWorks, Faq, Cta } from '../components/Sections.jsx';
import ConverterCard from '../components/ConverterCard.jsx';

/** One landing page (home, PDF to Word, Arabic PDF, OCR, privacy). Each has its own URL, title and copy. */
export default function Landing({ pageKey }) {
  const { lang, t } = useI18n();
  const [caps, setCaps] = useState(null);
  const isPrivacy = pageKey === 'privacy';

  // keep <head> (title, canonical, hreflang, JSON-LD) in sync on client-side navigation
  useEffect(() => {
    applyHead(buildHead({ lang, pageKey }));
  }, [lang, pageKey]);

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg">{t('skip')}</a>
      <Header pageKey={pageKey} />
      <main id="main" key={`${lang}-${pageKey}`} className="page-fade">
        <Hero pageKey={pageKey} />
        {!isPrivacy && <ConverterCard onCapabilities={setCaps} />}
        <Article pageKey={pageKey} />
        {isPrivacy ? (
          <div className="mt-10 text-center">
            <Link to={pathFor(lang, 'home')}><Button type="primary" size="large">{t('cta.button')}</Button></Link>
          </div>
        ) : (
          <>
            <Features />
            <HowItWorks />
            <Faq maxUploadMb={caps?.limits?.maxUploadMb ?? 500} />
            <Cta />
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
