import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Drawer, Segmented } from 'antd';
import {
  SunOutlined, MoonOutlined, DesktopOutlined, GlobalOutlined, MenuOutlined, HomeOutlined, FilePdfOutlined,
  TranslationOutlined, ScanOutlined, SafetyOutlined,
} from '@ant-design/icons';
import { useI18n, pathFor, PAGES } from '../i18n/index.jsx';
import { useTheme } from './Theme.jsx';

const NAV_ICONS = { home: HomeOutlined, pdfToWord: FilePdfOutlined, arabicPdf: TranslationOutlined, ocr: ScanOutlined, privacy: SafetyOutlined };

export function Logo({ className = 'h-9 w-9' }) {
  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#2f8478" />
      <path d="M18 12h20l10 10v30a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z" fill="#fff" />
      <path d="M38 12v10h10z" fill="#99f6e4" />
      <path d="M24 34h16M24 40h16M24 46h10" stroke="#2f8478" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Light / Auto (follows the device) / Dark - all driven by Tailwind's `dark` class. */
export function ThemeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const opt = (value, Icon) => ({
    value,
    label: (
      <span title={t(`theme.${value}`)} aria-label={t(`theme.${value}`)} className="inline-flex items-center px-0.5">
        <Icon aria-hidden="true" />
      </span>
    ),
  });
  return (
    <Segmented
      size="small"
      value={mode}
      onChange={setMode}
      aria-label={t('theme.label')}
      options={[opt('light', SunOutlined), opt('system', DesktopOutlined), opt('dark', MoonOutlined)]}
    />
  );
}

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/** Slide-in navigation (side bar): blurred backdrop + linear-gradient background. */
function SideMenu({ open, onClose, pageKey }) {
  const { lang, dir, t } = useI18n();
  const otherLang = lang === 'ar' ? 'en' : 'ar';
  return (
    <Drawer
      open={open}
      onClose={onClose}
      rootClassName="side-menu"
      placement={dir === 'rtl' ? 'right' : 'left'}
      size={300}
      title={<span className="flex items-center gap-2.5 font-extrabold text-white"><Logo className="h-8 w-8" /> {t('menu.title')}</span>}
      styles={{ body: { padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 6 } }}
    >
      <nav aria-label={t('menu.title')} className="grid gap-1.5">
        {PAGES.map((p, i) => {
          const Icon = NAV_ICONS[p.key];
          return (
            <Link
              key={p.key}
              to={pathFor(lang, p.key)}
              onClick={onClose}
              aria-current={pageKey === p.key ? 'page' : undefined}
              className="side-link side-link-enter"
              style={{ animationDelay: `${60 + i * 55}ms` }}
            >
              <Icon aria-hidden="true" className="text-lg" /> {t(`nav.${p.key}`)}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto grid gap-3 border-t border-white/15 pt-4">
        <Link to={pathFor(otherLang, pageKey)} onClick={onClose} hrefLang={otherLang} lang={otherLang} className="side-link" aria-label={t('langSwitchLabel')}>
          <GlobalOutlined aria-hidden="true" className="text-lg" /> {t('langSwitch')}
        </Link>
        <div className="flex items-center justify-between gap-3 px-1 text-sm font-semibold text-white/90">
          <span>{t('theme.label')}</span>
          <ThemeSwitch />
        </div>
      </div>
    </Drawer>
  );
}

export function Header({ pageKey }) {
  const { lang, t } = useI18n();
  const scrolled = useScrolled();
  const [menu, setMenu] = useState(false);
  const otherLang = lang === 'ar' ? 'en' : 'ar';
  const navKeys = PAGES.filter((p) => p.key !== 'home');
  return (
    <header className={`glass-nav sticky top-0 z-40 ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <Button className="lg:!hidden" type="text" shape="circle" icon={<MenuOutlined />} aria-label={t('menu.open')} onClick={() => setMenu(true)} />
        <Link to={pathFor(lang, 'home')} className="flex items-center gap-2.5 font-extrabold text-slate-900 no-underline dark:text-slate-100" aria-label={t('appName')}>
          <Logo />
          <span className="hidden text-lg sm:inline">{t('appName')}</span>
        </Link>
        <nav aria-label="Main" className="ms-4 hidden items-center gap-1 lg:flex">
          {navKeys.map((p) => (
            <Link
              key={p.key}
              to={pathFor(lang, p.key)}
              aria-current={pageKey === p.key ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${pageKey === p.key ? 'bg-brand-100/80 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200' : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/10'}`}
            >
              {t(`nav.${p.key}`)}
            </Link>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-1.5">
          <span className="hidden sm:inline-flex"><ThemeSwitch /></span>
          <Link to={pathFor(otherLang, pageKey)} hrefLang={otherLang} lang={otherLang} aria-label={t('langSwitchLabel')} className="no-underline">
            <Button icon={<GlobalOutlined />} tabIndex={-1}>{t('langSwitch')}</Button>
          </Link>
        </div>
      </div>
      <SideMenu open={menu} onClose={() => setMenu(false)} pageKey={pageKey} />
    </header>
  );
}

export function Footer() {
  const { lang, t } = useI18n();
  return (
    <footer className="mt-20 border-t border-slate-200 bg-gradient-to-b from-white to-slate-50 py-10 dark:border-slate-800 dark:from-slate-950 dark:to-slate-950">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:px-6 md:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="mb-3 flex items-center gap-2.5 font-extrabold"><Logo className="h-8 w-8" /> {t('appName')}</div>
          <p className="mb-3 max-w-xl text-slate-600 dark:text-slate-400">{t('footer.tagline')}</p>
          <p className="max-w-xl text-xs leading-6 text-slate-500 dark:text-slate-500">{t('footer.credits')}</p>
        </div>
        <nav aria-label={t('footer.links')}>
          <div className="mb-3 font-bold">{t('footer.links')}</div>
          <ul className="m-0 grid list-none gap-2 p-0">
            {PAGES.map((p) => (
              <li key={p.key}>
                <Link to={pathFor(lang, p.key)} className="text-slate-600 no-underline hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-400">
                  {t(`nav.${p.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto mt-8 max-w-6xl px-4 text-xs text-slate-500 sm:px-6">{t('footer.rights', { y: new Date().getFullYear() })}</div>
    </footer>
  );
}
