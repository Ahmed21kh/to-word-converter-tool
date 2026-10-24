import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Radio, Select, Switch, Upload, Tooltip } from 'antd';
import { InboxOutlined, SettingOutlined, DeleteOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/index.jsx';
import { getCapabilities } from '../lib/api.js';
import { useConversions } from '../lib/useConversions.js';
import { formatBytes } from '../lib/format.js';
import FileItem from './FileItem.jsx';

const ReportDrawer = lazy(() => import('./ReportDrawer.jsx'));
const PreviewDrawer = lazy(() => import('./PreviewDrawer.jsx'));

const DEFAULT_OPTIONS = {
  format: 'docx', mode: 'smart', language: 'ar', engine: 'standard', quran: 'correct',
  highlightUncertain: false, detectHeadings: true, arabicFont: 'Traditional Arabic',
};
const FALLBACK_CAPS = {
  accept: ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.txt', '.md', '.csv'],
  outputs: ['docx'], limits: { maxUploadMb: 500 }, retentionMinutes: 60,
};
const FONTS = ['Traditional Arabic', 'Simplified Arabic', 'Sakkal Majalla', 'Arial', 'Tahoma', 'Times New Roman', 'Calibri'];
const STORAGE_KEY = 'p2w-options-v2'; // bumped: v1 saved highlightUncertain=true for everybody

export default function ConverterCard({ onCapabilities }) {
  const { t } = useI18n();
  const [caps, setCaps] = useState(FALLBACK_CAPS);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [rejected, setRejected] = useState([]);
  const [report, setReport] = useState(null); // {id, name}
  const [preview, setPreview] = useState(null); // {id, name}
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const { items, add, cancel, remove, retry, clearFinished } = useConversions(useCallback(() => optionsRef.current, []));

  // restore saved options + load server capabilities (after mount: keeps SSR/hydration identical)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') setOptions((o) => ({ ...o, ...saved }));
    } catch { /* ignore broken storage */ }
    getCapabilities()
      .then((c) => {
        setCaps(c);
        onCapabilities?.(c);
        if (!c.outputs.includes('doc')) setOptions((o) => (o.format === 'doc' ? { ...o, format: 'docx' } : o));
        if (!c.features?.ai?.available) setOptions((o) => (o.engine === 'ai' ? { ...o, engine: 'standard' } : o));
      })
      .catch(() => {});
  }, [onCapabilities]);

  const setOpt = (key, value) => {
    setOptions((o) => {
      const next = { ...o, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* storage unavailable */ }
      return next;
    });
  };

  const maxMb = caps.limits?.maxUploadMb ?? 500;
  const accept = useMemo(() => caps.accept.join(','), [caps.accept]);

  const beforeUpload = (file) => {
    const ext = `.${file.name.split('.').pop().toLowerCase()}`;
    let reason = null;
    if (!caps.accept.includes(ext)) reason = t('converter.errors.unsupported');
    else if (file.size === 0) reason = t('converter.errors.empty');
    else if (file.size > maxMb * 1024 * 1024) reason = t('converter.errors.tooLarge', { size: maxMb });
    if (reason) setRejected((r) => [...r, { name: file.name, reason, id: `${file.name}-${Date.now()}` }]);
    else add([file]);
    return false; // we upload ourselves (progress, queue, cancel)
  };

  const hasFinished = items.some((i) => ['done', 'error', 'cancelled'].includes(i.status));
  const docAvailable = caps.outputs.includes('doc');
  const ai = caps.features?.ai;

  const optionPanel = (
    <div className="grid gap-5 pt-1 md:grid-cols-2">
      <div className="md:col-span-2">
        <div className="mb-2 font-bold">{t('converter.options.mode')}</div>
        <Radio.Group value={options.mode} onChange={(e) => setOpt('mode', e.target.value)} className="!grid gap-2 md:!grid-cols-3">
          {['smart', 'ocr', 'exact'].map((m) => (
            <Radio key={m} value={m} className="!m-0 !flex !items-start rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="font-semibold">{t(`converter.options.mode${m[0].toUpperCase()}${m.slice(1)}`)}</div>
              <div className="text-xs leading-5 text-slate-500 dark:text-slate-400">{t(`converter.options.mode${m[0].toUpperCase()}${m.slice(1)}Hint`)}</div>
            </Radio>
          ))}
        </Radio.Group>
      </div>

      <div>
        <div className="mb-2 font-bold">{t('converter.options.format')}</div>
        <Radio.Group value={options.format} onChange={(e) => setOpt('format', e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="docx">{t('converter.options.formatDocx')}</Radio.Button>
          <Tooltip title={docAvailable ? undefined : t('converter.options.formatDocUnavailable')}>
            <Radio.Button value="doc" disabled={!docAvailable}>{t('converter.options.formatDoc')}</Radio.Button>
          </Tooltip>
        </Radio.Group>
      </div>

      <div>
        <div className="mb-2 font-bold">{t('converter.options.language')}</div>
        <Select
          value={options.language}
          onChange={(v) => setOpt('language', v)}
          className="w-full"
          options={[{ value: 'ar', label: t('converter.options.langAr') }, { value: 'mixed', label: t('converter.options.langMixed') }, { value: 'en', label: t('converter.options.langEn') }]}
        />
      </div>

      <div className="md:col-span-2">
        <div className="mb-2 font-bold">{t('converter.options.engine')}</div>
        <Radio.Group value={options.engine} onChange={(e) => setOpt('engine', e.target.value)} optionType="button" buttonStyle="solid">
          <Radio.Button value="standard">{t('converter.options.engineStandard')}</Radio.Button>
          <Tooltip title={ai?.available ? undefined : t('converter.options.engineAiUnavailable')}>
            <Radio.Button value="ai" disabled={!ai?.available}>{t('converter.options.engineAi')}</Radio.Button>
          </Tooltip>
        </Radio.Group>
        {options.engine === 'ai' && ai?.available && (
          <p className="mb-0 mt-2 text-xs leading-6 text-amber-700 dark:text-amber-400">
            {ai.external ? t('converter.options.engineAiHintExternal') : t('converter.options.engineAiHintLocal')}
          </p>
        )}
        {!ai?.available && <p className="mb-0 mt-2 text-xs text-slate-500">{t('converter.options.engineAiUnavailable')}</p>}
      </div>

      <div>
        <div className="mb-2 font-bold">{t('converter.options.quran')}</div>
        <Select
          value={options.quran}
          onChange={(v) => setOpt('quran', v)}
          className="w-full"
          options={[
            { value: 'correct', label: t('converter.options.quranCorrect') },
            { value: 'verify', label: t('converter.options.quranVerify') },
            { value: 'off', label: t('converter.options.quranOff') },
          ]}
        />
      </div>

      <div>
        <div className="mb-2 font-bold">{t('converter.options.font')}</div>
        <Select value={options.arabicFont} onChange={(v) => setOpt('arabicFont', v)} className="w-full" options={FONTS.map((f) => ({ value: f, label: <span style={{ fontFamily: f }}>{f}</span> }))} />
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <span className="font-semibold">{t('converter.options.highlight')}</span>
        <Switch checked={options.highlightUncertain} onChange={(v) => setOpt('highlightUncertain', v)} />
      </label>
      <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <span className="font-semibold">{t('converter.options.headings')}</span>
        <Switch checked={options.detectHeadings} onChange={(v) => setOpt('detectHeadings', v)} />
      </label>
    </div>
  );

  return (
    <section id="converter" aria-labelledby="converter-h" className="relative z-10 mx-auto -mt-20 max-w-4xl scroll-mt-24 px-4 sm:px-6">
      <div className="surface rise-in !rounded-3xl p-4 shadow-xl sm:p-6">
        <h2 id="converter-h" className="sr-only">{t('converter.title')}</h2>

        <Upload.Dragger
          multiple
          accept={accept}
          showUploadList={false}
          beforeUpload={beforeUpload}
          openFileDialogOnClick
          className="drop-zone"
        >
          <p className="mb-3 text-5xl text-brand-600 dark:text-brand-400"><span className="bob"><InboxOutlined aria-hidden="true" /></span></p>
          <p className="mb-1 text-lg font-bold">{t('converter.dropTitle')}</p>
          <p className="mb-4 px-2 text-sm text-slate-500 dark:text-slate-400">{t('converter.dropHint', { size: maxMb })}</p>
          <Button type="primary" size="large">{t('converter.chooseFiles')}</Button>
        </Upload.Dragger>

        <p className="mb-0 mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
          {t('converter.autoStart')} {t('converter.privacyNote', { m: caps.retentionMinutes ?? 60 })}
        </p>

        <Collapse
          ghost
          className="mt-2"
          items={[{ key: 'o', label: <span className="font-bold"><SettingOutlined className="me-2" aria-hidden="true" />{t('converter.optionsTitle')}</span>, children: optionPanel }]}
        />

        {rejected.length > 0 && (
          <div className="mt-3 grid gap-2">
            {rejected.map((r) => (
              <Alert key={r.id} type="warning" showIcon closable onClose={() => setRejected((x) => x.filter((i) => i.id !== r.id))}
                title={<span dir="auto" className="bidi-isolate">{r.name}</span>} description={r.reason} />
            ))}
          </div>
        )}

        <div className="mt-5" aria-live="polite">
          {items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('converter.emptyList')} />
          ) : (
            <>
              {hasFinished && (
                <div className="mb-2 flex justify-end">
                  <Button size="small" type="text" icon={<DeleteOutlined />} onClick={clearFinished}>{t('converter.actions.clear')}</Button>
                </div>
              )}
              <ul className="m-0 grid list-none gap-3 p-0">
                {items.map((item) => (
                  <FileItem key={item.uid} item={item} onCancel={cancel} onRemove={remove} onRetry={retry} onReport={(i) => setReport({ id: i.job.id, name: i.name })} onPreview={(i) => setPreview({ id: i.job.id, name: i.name })} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <p className="sr-only">{formatBytes(0)}</p>

      {preview && (
        <Suspense fallback={null}>
          <PreviewDrawer jobId={preview.id} name={preview.name} officeViewer={caps.features?.officeViewer} onClose={() => setPreview(null)} />
        </Suspense>
      )}
      {report && (
        <Suspense fallback={null}>
          <ReportDrawer open jobId={report.id} name={report.name} onClose={() => setReport(null)} />
        </Suspense>
      )}
    </section>
  );
}
