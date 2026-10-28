import { useEffect, useState } from 'react';
import { Alert, Drawer, Spin, Table, Tag } from 'antd';
import { useI18n } from '../i18n/index.jsx';
import { getReport } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';

const STATUS_COLOR = { corrected: 'blue', 'diacritics-fixed': 'cyan', unmatched: 'red', 'needs-review': 'orange', verified: 'green' };

function Stat({ label, value, tone }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="truncate text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div dir="auto" className={`truncate text-xl font-extrabold ${tone || ''}`}>{value}</div>
    </div>
  );
}

export default function ReportDrawer({ jobId, name, onClose }) {
  const { t, raw, dir } = useI18n();
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getReport(jobId).then((r) => alive && setReport(r)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [jobId]);

  const q = report?.quran;
  const drawerWidth = typeof window === 'undefined' ? 760 : Math.min(760, window.innerWidth);
  // conversion time in the page's language: "45 ث" / "2.0 د"
  const duration = (ms) => (ms < 60_000 ? t('converter.etaSeconds', { n: Math.max(1, Math.round(ms / 1000)) }) : t('converter.etaMinutes', { n: (ms / 60_000).toFixed(1) }));

  return (
    <Drawer
      open
      onClose={onClose}
      size={drawerWidth}
      placement={dir === 'rtl' ? 'left' : 'right'}
      destroyOnHidden
      rootClassName="glass-drawer"
      title={<span className="flex min-w-0 items-center gap-2"><span>{t('report.title')}</span><span dir="auto" className="bidi-isolate truncate text-sm font-normal text-slate-500">{name}</span></span>}
    >
      {!report && !failed && <div className="py-20 text-center"><Spin /> <div className="mt-3 text-slate-500">{t('report.loading')}</div></div>}
      {failed && <Alert type="error" showIcon title={t('report.failed')} />}
      {report && (
        <div className="grid min-w-0 gap-7 *:min-w-0">
          <section>
            <h3 className="mb-3 text-lg font-bold">{t('report.summary')}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('report.pages')} value={report.pages ?? '—'} />
              <Stat label={t('report.time')} value={duration(report.durationMs)} />
              <Stat label={t('report.size')} value={formatBytes(report.outputBytes)} />
              <Stat label={t('report.reviewPages')} value={report.reviewPages.length} tone={report.reviewPages.length ? 'text-amber-600' : 'text-emerald-600'} />
            </div>
            <div className="mt-4 text-sm font-semibold">{t('report.methods')}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(report.methods).map(([k, v]) => <Tag key={k} className="!m-0 !text-sm">{t(`report.method.${k}`)}: {v}</Tag>)}
            </div>
          </section>

          {report.scan?.aiPages > 0 && (
            <Alert type="success" showIcon title={t('report.method.ai')} description={t('report.aiText', { pages: report.scan.aiPages, inTok: report.scan.aiInputTokens.toLocaleString(), outTok: report.scan.aiOutputTokens.toLocaleString() })} />
          )}
          {report.printMatch && (
            <Alert type="info" showIcon title={t('converter.options.printMatch')} description={[
              t('report.printMatchText', { pages: report.printMatch.pages, shrunk: report.printMatch.shrunk, pct: Math.round(report.printMatch.smallestScale * 100) }),
              report.printMatch.heads && t('report.printMatchHeads', { titles: report.printMatch.heads.titles, dropped: report.printMatch.heads.dropped, cards: report.printMatch.heads.cards || 0, cardDropped: report.printMatch.heads.cardLinesDropped || 0 }),
            ].filter(Boolean).join(' ')} />
          )}
          {report.scan?.ocrPages > 0 && (
            <Alert type="info" showIcon title={t('report.scanTitle')} description={t('report.scanText', { ocr: report.scan.ocrPages, strip: report.scan.diacriticsStripped, pics: report.scan.keptAsPictures })} />
          )}

          <section>
            <h3 className="mb-3 text-lg font-bold">{t('report.quran')}</h3>
            {q.found === 0 && q.items.length === 0 ? (
              <p className="text-slate-500">{t('report.quranNone')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Stat label={t('report.quranFound')} value={q.found} />
                  <Stat label={t('report.quranVerified')} value={q.verified} tone="text-emerald-600" />
                  <Stat label={t('report.quranCorrected')} value={q.corrected} tone="text-blue-600" />
                  <Stat label={t('report.quranDiacritics')} value={q.diacriticsFixed} tone="text-cyan-600" />
                  <Stat label={t('report.quranUnmatched')} value={q.unmatched} tone={q.unmatched ? 'text-red-600' : ''} />
                  <Stat label={t('report.quranCitation')} value={q.citationWarnings} tone={q.citationWarnings ? 'text-amber-600' : ''} />
                </div>
                <ul className="m-0 mt-4 grid max-h-[420px] list-none gap-3 overflow-y-auto overflow-x-hidden p-0">
                  {q.items.slice(0, 200).map((it, i) => (
                    <li key={i} className="min-w-0 wrap-break-word rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                        <Tag color={STATUS_COLOR[it.status]} className="!m-0">{t(`report.status.${it.status}`)}</Tag>
                        <span className="font-semibold">{t('report.page')} {it.page}</span>
                        {it.ref && <span dir="rtl" className="bidi-isolate text-slate-600 dark:text-slate-300">{it.ref}</span>}
                        {it.lowConfidence && <Tag color="warning" className="!m-0">{t('report.quranLowConf')}</Tag>}
                      </div>
                      {it.citationWarning && <div className="mb-2 text-xs text-amber-700 dark:text-amber-400">{it.citationWarning}</div>}
                      <div className="text-xs text-slate-500">{t('report.before')}</div>
                      <div dir="rtl" className="quran-text mb-1 rounded-lg bg-slate-50 p-2 dark:bg-slate-800">{it.text}</div>
                      {it.fixedTo && (
                        <>
                          <div className="text-xs text-slate-500">{t('report.after')}</div>
                          <div dir="rtl" className="quran-text rounded-lg bg-emerald-50 p-2 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{it.fixedTo}</div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-lg font-bold">{t('report.reviewPages')}</h3>
            {report.reviewPages.length === 0 ? (
              <p className="text-slate-500">{t('report.noReview')}</p>
            ) : (
              <>
                <p className="text-sm text-slate-600 dark:text-slate-400">{t('report.reviewHint')}</p>
                <div className="flex flex-wrap gap-1.5">{report.reviewPages.map((n) => <Tag key={n} color="warning" className="!m-0">{n}</Tag>)}</div>
              </>
            )}
          </section>

          {report.pageDetails?.length > 0 && (
            <section>
              <h3 className="mb-3 text-lg font-bold">{t('report.pageTable')}</h3>
              <Table
                size="small"
                rowKey="n"
                dataSource={report.pageDetails}
                pagination={{ pageSize: 15, showSizeChanger: false, hideOnSinglePage: true }}
                tableLayout="fixed"
                columns={[
                  { title: t('report.page'), dataIndex: 'n', width: 64 },
                  { title: '', dataIndex: 'method', width: '28%', render: (m) => <Tag className="!m-0 max-w-full !whitespace-normal">{t(`report.method.${m}`)}</Tag> },
                  { title: t('report.chars'), dataIndex: 'chars', width: 64 },
                  { title: t('report.confidence'), width: 64, render: (_, r) => (r.confidence != null ? `${r.confidence}%` : r.quality != null ? `${Math.round(r.quality * 100)}%` : '—') },
                  // long notes wrap inside their cell: the drawer never scrolls sideways
                  { title: t('report.warnings'), render: (_, r) => <div className="flex flex-wrap gap-1">{(r.warnings || []).map((w) => <Tag key={w} title={w} color={raw(`report.note.${w.split(':')[0]}`) && w.startsWith('front') ? 'default' : 'warning'} className="!m-0 max-w-full !whitespace-normal break-all">{raw(`report.note.${w.split(':')[0]}`) || w}</Tag>)}</div> },
                ]}
              />
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
