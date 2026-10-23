import { Collapse, Button } from 'antd';
import {
  TranslationOutlined, BookOutlined, ScanOutlined, PictureOutlined, RocketOutlined, SafetyCertificateOutlined,
  CheckCircleFilled, ThunderboltFilled, LockFilled,
} from '@ant-design/icons';
import { useI18n } from '../i18n/index.jsx';
import Reveal from './Reveal.jsx';

const ICONS = {
  translation: TranslationOutlined,
  book: BookOutlined,
  scan: ScanOutlined,
  picture: PictureOutlined,
  rocket: RocketOutlined,
  safety: SafetyCertificateOutlined,
};

export function Hero({ pageKey }) {
  const { dict } = useI18n();
  const page = dict.pages[pageKey];
  return (
    <section className="hero-bg border-b border-slate-200/70 pb-28 pt-12 text-center dark:border-slate-800 sm:pt-16">
      <span className="blob blob-a" aria-hidden="true" />
      <span className="blob blob-b" aria-hidden="true" />
      <div className="hero-stagger mx-auto max-w-4xl px-4 sm:px-6">
        <div>
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/90 px-4 py-1.5 text-sm font-bold text-brand-800 backdrop-blur dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-200">
            <ThunderboltFilled aria-hidden="true" /> {page.kicker}
          </span>
        </div>
        <h1 className="mb-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl dark:text-slate-100">{page.h1}</h1>
        <p className="mx-auto max-w-3xl text-base leading-8 text-slate-600 sm:text-lg dark:text-slate-300">{page.sub}</p>
        <ul className="m-0 mt-6 flex list-none flex-wrap items-center justify-center gap-x-6 gap-y-2 p-0 text-sm font-semibold text-slate-600 dark:text-slate-300">
          {dict.features.items.slice(0, 3).map((f) => (
            <li key={f.title} className="inline-flex items-center gap-1.5">
              <CheckCircleFilled className="text-brand-600 dark:text-brand-400" aria-hidden="true" /> {f.title}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Article({ pageKey }) {
  const { dict } = useI18n();
  const art = dict.pages[pageKey].article;
  if (!art) return null;
  return (
    <section className="mx-auto mt-16 max-w-4xl px-4 sm:px-6" aria-labelledby="article-h">
      <Reveal>
        <h2 id="article-h" className="mb-5 text-2xl font-extrabold sm:text-3xl">{art.h2}</h2>
      </Reveal>
      {art.paras.map((p, i) => (
        <Reveal key={p.slice(0, 30)} as="p" delay={i * 70} className="mb-4 text-base leading-8 text-slate-700 dark:text-slate-300">{p}</Reveal>
      ))}
      <ul className="mt-6 grid gap-3 p-0 sm:grid-cols-2">
        {art.bullets.map((b, i) => (
          <Reveal key={b} as="li" delay={i * 80} className="surface flex list-none items-start gap-2.5 !rounded-xl p-4 font-semibold">
            <CheckCircleFilled className="mt-1.5 text-brand-600 dark:text-brand-400" aria-hidden="true" /> <span>{b}</span>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}

export function Features() {
  const { dict } = useI18n();
  const f = dict.features;
  return (
    <section className="mx-auto mt-20 max-w-6xl px-4 sm:px-6" aria-labelledby="features-h">
      <Reveal className="mb-10 text-center">
        <h2 id="features-h" className="mb-2 text-2xl font-extrabold sm:text-4xl">{f.title}</h2>
        <p className="text-slate-600 dark:text-slate-400">{f.subtitle}</p>
      </Reveal>
      <ul className="m-0 grid list-none gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {f.items.map((it, i) => {
          const Icon = ICONS[it.icon] || SafetyCertificateOutlined;
          return (
            <Reveal key={it.title} as="li" delay={(i % 3) * 90} className="surface lift p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-100 to-brand-50 text-2xl text-brand-700 ring-1 ring-brand-200/60 dark:from-brand-900/70 dark:to-brand-900/30 dark:text-brand-300 dark:ring-brand-800/60">
                <Icon aria-hidden="true" />
              </div>
              <h3 className="mb-2 text-lg font-bold">{it.title}</h3>
              <p className="m-0 leading-7 text-slate-600 dark:text-slate-400">{it.text}</p>
            </Reveal>
          );
        })}
      </ul>
    </section>
  );
}

export function HowItWorks() {
  const { dict } = useI18n();
  return (
    <section className="mx-auto mt-20 max-w-5xl px-4 sm:px-6" aria-labelledby="how-h">
      <Reveal>
        <h2 id="how-h" className="mb-10 text-center text-2xl font-extrabold sm:text-4xl">{dict.how.title}</h2>
      </Reveal>
      <ol className="m-0 grid list-none gap-5 p-0 md:grid-cols-3">
        {dict.how.steps.map((s, i) => (
          <Reveal key={s.title} as="li" delay={i * 120} className="surface lift relative p-6">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-lg font-extrabold text-white shadow-md shadow-brand-700/30" aria-hidden="true">{i + 1}</span>
            <h3 className="mb-1.5 text-lg font-bold">{s.title}</h3>
            <p className="m-0 leading-7 text-slate-600 dark:text-slate-400">{s.text}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

export function Faq({ maxUploadMb = 500 }) {
  const { dict } = useI18n();
  const items = dict.faq.items.map((f, i) => ({
    key: String(i),
    label: <span className="font-bold">{f.q}</span>,
    children: <p className="m-0 leading-8 text-slate-700 dark:text-slate-300">{f.a.replace('{size}', String(maxUploadMb))}</p>,
  }));
  return (
    <section className="mx-auto mt-20 max-w-3xl px-4 sm:px-6" aria-labelledby="faq-h">
      <Reveal>
        <h2 id="faq-h" className="mb-8 text-center text-2xl font-extrabold sm:text-4xl">{dict.faq.title}</h2>
      </Reveal>
      <Reveal delay={80} className="surface overflow-hidden px-2 py-1">
        <Collapse items={items} bordered={false} className="!bg-transparent" accordion defaultActiveKey={['0']} />
      </Reveal>
    </section>
  );
}

export function Cta({ href = '#converter' }) {
  const { t } = useI18n();
  return (
    <Reveal as="section" className="mx-auto mt-20 max-w-4xl px-4 sm:px-6">
      <div className="rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 px-6 py-12 text-center text-white shadow-xl shadow-brand-900/20 ring-1 ring-white/10">
        <LockFilled className="mb-3 text-3xl opacity-80" aria-hidden="true" />
        <h2 className="mb-5 text-2xl font-extrabold sm:text-3xl">{t('cta.title')}</h2>
        <Button size="large" href={href} className="!font-bold">{t('cta.button')}</Button>
      </div>
    </Reveal>
  );
}
