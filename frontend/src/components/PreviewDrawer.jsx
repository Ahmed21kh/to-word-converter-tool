import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Drawer, InputNumber, Segmented, Slider, Spin, Alert } from 'antd';
import { DownloadOutlined, LeftOutlined, RightOutlined, ZoomInOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/index.jsx';
import { downloadUrl, getPreview, previewImageUrl } from '../lib/api.js';

const AR_FONT = "'Traditional Arabic', 'Amiri', 'Scheherazade New', 'Cairo', serif";
const LAT_FONT = "'Times New Roman', 'Cairo', serif";
// verses between the ornate brackets are shown like a Mushaf quotation
const VERSE = /([\uFD3F\uFD3E][^\uFD3E\uFD3F]*[\uFD3E\uFD3F])/;
const UNMAPPED = '\uFFFD';

function Run({ run }) {
  const style = { fontWeight: run.b ? 700 : undefined, fontStyle: run.i ? 'italic' : undefined };
  const base = run.l ? { ...style, background: '#fde68a', borderRadius: 2 } : style;
  return run.x.split(VERSE).map((part, i) => {
    if (!part) return null;
    if (VERSE.test(part)) {
      return <span key={i} className="quran-text" style={{ ...base, fontWeight: 700 }}>{part}</span>;
    }
    if (part.includes(UNMAPPED)) {
      return part.split(UNMAPPED).flatMap((seg, k, arr) => [
        seg && <span key={`${i}a${k}`} style={base}>{seg}</span>,
        k < arr.length - 1 && <mark key={`${i}b${k}`} style={{ background: '#fde047', color: '#b91c1c' }}>{UNMAPPED}</mark>,
      ]);
    }
    return <span key={i} style={base}>{part}</span>;
  });
}

function Para({ p }) {
  const style = {
    margin: 0,
    marginTop: p.sb || 0,
    fontSize: p.fs,
    lineHeight: p.lh ? `${p.lh}px` : 1.5,
    textAlign: p.al === 'both' ? 'justify' : p.al === 'start' ? 'start' : p.al,
    fontFamily: p.dir === 'rtl' ? AR_FONT : LAT_FONT,
    overflowWrap: 'anywhere',
  };
  return <p dir={p.dir} style={style}>{p.runs.map((r, i) => <Run key={i} run={r} />)}</p>;
}

function Table({ b }) {
  const total = b.widths.reduce((a, c) => a + c, 0);
  const rows = Array.from({ length: b.rows }, (_, r) => b.cells.filter((c) => c.r === r).sort((x, y) => x.c - y.c));
  return (
    <table dir={b.rtl ? 'rtl' : 'ltr'} style={{ width: total, maxWidth: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', margin: '6px auto' }}>
      <colgroup>{b.widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <tbody>
        {rows.map((cells, r) => (
          <tr key={r}>
            {cells.map((c) => (
              <td key={`${c.r}-${c.c}`} rowSpan={c.rs} colSpan={c.cs} style={{ border: '1px solid #475569', padding: '3px 5px', verticalAlign: 'middle' }}>
                {c.ps.map((p, i) => <Para key={i} p={p} />)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Paper({ page, jobId, scale }) {
  const [mt, mr, mb, ml] = page.m;
  return (
    <div style={{ width: page.w * scale, height: page.h * scale, margin: '0 auto', direction: 'ltr', position: 'relative' }}>
      <article
        aria-label={`${page.n}`}
        style={{
          position: 'absolute', insetInlineStart: 0, top: 0, left: 0, width: page.w, minHeight: page.h, transform: `scale(${scale})`, transformOrigin: 'top left', background: '#fff', color: '#111',
          padding: `${mt}px ${mr}px ${mb}px ${ml}px`, boxSizing: 'border-box', boxShadow: '0 4px 24px rgba(15,23,42,.18)', overflow: 'hidden',
        }}
      >
        {page.blocks.map((b, i) => {
          if (b.t === 'p') return <Para key={i} p={b} />;
          if (b.t === 't') return <Table key={i} b={b} />;
          return (
            <img key={i} src={previewImageUrl(jobId, b.img)} alt="" loading="lazy"
              style={{ display: 'block', margin: '4px auto', width: b.full ? '100%' : b.w, maxWidth: '100%', height: 'auto' }} />
          );
        })}
      </article>
    </div>
  );
}

// Microsoft's online viewer opens the .docx from its public address (only possible on a published https site)
const officeEmbedUrl = (baseUrl, jobId) => `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(`${baseUrl}/api/jobs/${jobId}/document.docx`)}`;

function WordViewer({ src }) {
  const { t } = useI18n();
  const [agreed, setAgreed] = useState(false);
  if (!agreed) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <Alert type="info" showIcon title={t('preview.wordConsentTitle')} description={t('preview.wordConsent')} />
        <Button type="primary" className="mt-5" onClick={() => setAgreed(true)}>{t('preview.wordLoad')}</Button>
      </div>
    );
  }
  return <iframe title={t('preview.viewWord')} src={src} className="h-full min-h-[70vh] w-full rounded border-0 bg-white" referrerPolicy="no-referrer" />;
}

export default function PreviewDrawer({ jobId, name, officeViewer, onClose }) {
  const { t, dir } = useI18n();
  const [view, setView] = useState('quick');
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [state, setState] = useState('loading');
  const [, force] = useState(0);
  const cache = useRef(new Map());
  const [wrapEl, setWrapEl] = useState(null);
  const [width, setWidth] = useState(0);

  const load = useCallback(async (n) => {
    if (cache.current.has(n)) return;
    const res = await getPreview(jobId, n, 4);
    setTotal(res.total);
    res.pages.forEach((p) => cache.current.set(p.n, p));
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    setState('loading');
    load(pageNo)
      .then(() => {
        if (!alive) return;
        setState('ready');
        force((x) => x + 1);
        if (pageNo + 1 <= total || total === 0) load(pageNo + 1).catch(() => {});
      })
      .catch(() => alive && setState('error'));
    return () => { alive = false; };
  }, [pageNo, load, total]);

  useEffect(() => {
    if (!wrapEl) return undefined;
    const measure = () => setWidth(wrapEl.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);

  const page = cache.current.get(pageNo);
  const fit = page && width ? Math.max(0.3, Math.min(1.6, (width - 40) / page.w)) : 0.8;
  const scale = fit * (zoom / 100);
  const go = (n) => setPageNo(Math.min(Math.max(1, n), total || 1));
  const Prev = dir === 'rtl' ? RightOutlined : LeftOutlined;
  const Next = dir === 'rtl' ? LeftOutlined : RightOutlined;
  const drawerWidth = typeof window === 'undefined' ? 900 : Math.min(980, window.innerWidth);

  return (
    <Drawer
      open
      onClose={onClose}
      size={drawerWidth}
      placement={dir === 'rtl' ? 'left' : 'right'}
      destroyOnHidden
      rootClassName="glass-drawer"
      title={<span className="flex min-w-0 items-center gap-2"><span>{t('preview.title')}</span><span dir="auto" className="bidi-isolate truncate text-sm font-normal text-slate-500">{name}</span></span>}
      extra={<Button type="primary" icon={<DownloadOutlined />} href={downloadUrl(jobId)} download>{t('converter.actions.download')}</Button>}
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2.5 dark:border-slate-700">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'quick', label: t('preview.viewQuick') },
            { value: 'word', label: t('preview.viewWord'), disabled: !officeViewer?.available },
          ]}
        />
        {view === 'quick' && <div className="flex items-center gap-1.5">
          <Button icon={<Prev />} onClick={() => go(pageNo - 1)} disabled={pageNo <= 1} aria-label={t('preview.prev')} />
          <span className="text-sm">{t('preview.page')}</span>
          <InputNumber min={1} max={total || 1} value={pageNo} onChange={(v) => v && go(Number(v))} controls={false} className="!w-16" aria-label={t('preview.goTo')} />
          <span className="text-sm">{t('preview.of')} {total || '…'}</span>
          <Button icon={<Next />} onClick={() => go(pageNo + 1)} disabled={pageNo >= total} aria-label={t('preview.next')} />
        </div>}
        {view === 'quick' && <div className="ms-auto flex min-w-[170px] items-center gap-2">
          <ZoomInOutlined aria-hidden="true" />
          <Slider className="!m-0 flex-1" min={50} max={200} step={10} value={zoom} onChange={setZoom} aria-label={t('preview.zoom')} tooltip={{ formatter: (v) => `${v}%` }} />
        </div>}
        {!officeViewer?.available && <span className="text-xs text-slate-500 dark:text-slate-400">{t('preview.wordUnavailable')}</span>}
      </div>

      {view === 'word' && officeViewer?.available ? (
        <div dir="ltr" className="min-h-0 flex-1 overflow-auto bg-slate-200/70 p-3 dark:bg-slate-950">
          <WordViewer src={officeEmbedUrl(officeViewer.baseUrl, jobId)} />
        </div>
      ) : (
      <div ref={setWrapEl} dir="ltr" className="min-h-0 flex-1 overflow-auto bg-slate-200/70 p-5 dark:bg-slate-950">
        {state === 'loading' && !page && <div className="py-24 text-center"><Spin /> <div className="mt-3 text-slate-500">{t('preview.loading')}</div></div>}
        {state === 'error' && <Alert type="error" showIcon title={t('preview.failed')} />}
        {page && <div key={page.n} className="fade-in"><Paper page={page} jobId={jobId} scale={scale} /></div>}
      </div>
      )}

      <div className="border-t border-slate-200 px-4 py-2 text-xs leading-6 text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {view === 'word' ? t('preview.wordNote') : t('preview.note')}
      </div>
    </Drawer>
  );
}
