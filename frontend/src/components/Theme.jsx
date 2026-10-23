import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import { useI18n } from '../i18n/index.jsx';

/** mode: 'light' | 'dark' | 'system' ; dark: the resolved boolean actually applied */
const ThemeContext = createContext({ mode: 'system', dark: false, setMode: () => {} });
export const useTheme = () => useContext(ThemeContext);

const LOCALES = { ar: arEG, en: enUS };
const MODES = ['light', 'dark', 'system'];

const prefersDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
const resolve = (mode) => mode === 'dark' || (mode === 'system' && prefersDark());

/**
 * Theme + Ant Design configuration.
 * Tailwind's `dark:` variant follows the `dark` class on <html>; Ant Design follows the same value
 * through its dark algorithm. The first render is always "system/light" so server HTML and client
 * hydration match; the stored preference (already applied to <html> by theme-init.js before paint)
 * is synced right after mount.
 */
export function AppConfig({ children }) {
  const { lang, dir } = useI18n();
  const [mode, setModeState] = useState('system');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let saved = 'system';
    try {
      const v = localStorage.getItem('theme');
      if (MODES.includes(v)) saved = v;
    } catch { /* storage unavailable */ }
    setModeState(saved);
  }, []);

  // apply + follow the operating system while in "system" mode
  useEffect(() => {
    const apply = () => {
      const isDark = resolve(mode);
      document.documentElement.classList.toggle('dark', isDark);
      setDark(isDark);
    };
    apply();
    if (mode !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  const setMode = useCallback((next) => {
    if (!MODES.includes(next)) return;
    setModeState(next);
    try {
      localStorage.setItem('theme', next);
    } catch { /* private mode: keep for this session only */ }
  }, []);

  const value = useMemo(() => ({ mode, dark, setMode }), [mode, dark, setMode]);
  const themeConfig = useMemo(() => ({
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#4fb0a1' : '#2f8478',
      borderRadius: 12,
      fontFamily: "'Cairo', ui-sans-serif, system-ui, 'Segoe UI', Tahoma, Arial, sans-serif",
      colorBgBase: dark ? '#1a2220' : '#fffefb',
      colorBgContainer: dark ? '#1a2220' : '#fffefb',
      colorBgElevated: dark ? '#222c29' : '#fffefb',
      colorBgLayout: dark ? '#0f1514' : '#f4f5f1',
      colorBorder: dark ? '#35413d' : '#d4d9d0',
      colorBorderSecondary: dark ? '#28312d' : '#e4e7e0',
      colorText: dark ? '#dbe2da' : '#1f2925',
      colorTextSecondary: dark ? '#a9b4a8' : '#535e55',
      colorTextTertiary: dark ? '#7e897d' : '#6f796d',
      colorSuccess: dark ? '#6fc293' : '#3d8f63',
      colorWarning: dark ? '#e0b45a' : '#b8832a',
      colorError: dark ? '#e07b72' : '#c4554d',
      controlHeight: 38,
      wireframe: false,
    },
    components: {
      Button: { fontWeight: 600, primaryShadow: 'none', ...(dark ? { primaryColor: '#0f1514' } : {}) },
      Segmented: { trackBg: dark ? '#222c29' : '#e8ebe5' },
      Collapse: { headerBg: 'transparent' },
    },
  }), [dark]);

  return (
    <ThemeContext.Provider value={value}>
      <StyleProvider layer>
        <ConfigProvider direction={dir} locale={LOCALES[lang]} theme={themeConfig}>
          {children}
        </ConfigProvider>
      </StyleProvider>
    </ThemeContext.Provider>
  );
}
