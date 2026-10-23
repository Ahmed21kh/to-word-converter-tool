import { memo, useEffect, useState } from 'react';
import { Button, Progress, Tag } from 'antd';
import {
  FilePdfOutlined, FileImageOutlined, FileTextOutlined, FileOutlined, DownloadOutlined, CloseOutlined,
  ReloadOutlined, FileSearchOutlined, DeleteOutlined, CheckCircleFilled, WarningFilled, EyeOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/index.jsx';
import { downloadUrl, getReport } from '../lib/api.js';
import { fileKind, formatBytes } from '../lib/format.js';

const KIND_ICON = { pdf: FilePdfOutlined, image: FileImageOutlined, text: FileTextOutlined, other: FileOutlined };

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function FileItem({ item, onCancel, onRemove, onRetry, onReport, onPreview }) {
  const { t } = useI18n();
  const { status, job, uploadPct } = item;
  const processing = status === 'processing';
  const now = useNow(processing);
  const [summary, setSummary] = useState(null);

  // when a job finishes, fetch a short summary for the row (pages / pages needing review)
  const doneId = status === 'done' ? job?.id : null;
  useEffect(() => {
    if (!doneId) return undefined;
    let alive = true;
    getReport(doneId).then((r) => alive && setSummary({ pages: r.pages, review: r.reviewPages?.length ?? 0 })).catch(() => {});
    return () => { alive = false; };
  }, [doneId]);

  const Icon = KIND_ICON[fileKind(item.name)] || FileOutlined;

  let label;
  let percent = 0;
  let barStatus = 'active';
  if (status === 'uploading') {
    label = `${t('converter.status.uploading')} ${uploadPct}%`;
    percent = uploadPct;
  } else if (status === 'queued') {
    label = job?.queuePosition > 0 ? t('converter.status.queued', { n: job.queuePosition }) : t('converter.status.analyzing');
  } else if (processing) {
    const p = job?.phase || 'analyzing';
    label = t(`converter.status.${p}`, { done: job?.progress?.done ?? 0, total: job?.progress?.total ?? 0 });
    percent = job?.percent ?? 0;
  } else if (status === 'done') {
    label = t('converter.status.done');
    percent = 100;
    barStatus = 'success';
  } else if (status === 'error') {
    label = item.error && item.errorKey === 'generic' && item.error !== 'expired' ? item.error : t(`converter.errors.${item.errorKey || 'generic'}`);
    barStatus = 'exception';
    percent = 100;
  } else {
    label = t('converter.status.cancelled');
    barStatus = 'normal';
  }

  let eta = null;
  if (processing && job?.startedAt && percent > 6 && percent < 99) {
    const secs = Math.max(1, Math.round(((now - job.startedAt) / 1000) * ((100 - percent) / percent)));
    eta = secs < 90 ? t('converter.etaSeconds', { n: secs }) : t('converter.etaMinutes', { n: Math.ceil(secs / 60) });
  }
  const finished = ['done', 'error', 'cancelled'].includes(status);

  return (
    <li className={`item-in rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5 transition-colors sm:p-4 dark:border-slate-700 dark:bg-slate-800/40 ${item.leaving ? 'item-out' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-2xl text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300"><Icon aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span dir="auto" className="bidi-isolate max-w-full truncate font-bold" title={item.name}>{item.name}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{formatBytes(item.size)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-slate-600 dark:text-slate-300">
            <span className={status === 'error' ? 'font-semibold text-red-600 dark:text-red-400' : ''}>
              {status === 'done' && <CheckCircleFilled className="pop-in me-1.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
              {label}
            </span>
            {eta && <span className="text-xs text-slate-500">{t('converter.eta', { t: eta })}</span>}
            {status === 'done' && summary && (
              <span className="inline-flex flex-wrap items-center gap-2 text-xs">
                <Tag className="!m-0">{t('converter.summary.pages', { n: summary.pages ?? '—' })}</Tag>
                {summary.review > 0 ? (
                  <Tag color="warning" className="!m-0" icon={<WarningFilled />}>{t('converter.summary.needReview', { n: summary.review })}</Tag>
                ) : (
                  <Tag color="success" className="!m-0" icon={<CheckCircleFilled />}>{t('converter.summary.allGood')}</Tag>
                )}
              </span>
            )}
          </div>
          {!finished || status === 'done' || status === 'error' ? (
            <Progress className="!mb-0 !mt-1.5" percent={percent} status={barStatus} showInfo={false} size="small" aria-label={label} />
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {status === 'done' && (
          <>
            {job?.hasPreview && <Button size="small" icon={<EyeOutlined />} onClick={() => onPreview(item)}>{t('converter.actions.preview')}</Button>}
            <Button size="small" icon={<FileSearchOutlined />} onClick={() => onReport(item)}>{t('converter.actions.report')}</Button>
            <Button type="primary" size="small" icon={<DownloadOutlined />} href={downloadUrl(job.id)} download>{t('converter.actions.download')}</Button>
          </>
        )}
        {status === 'error' && <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(item.uid)}>{t('converter.actions.retry')}</Button>}
        {!finished && <Button size="small" danger icon={<CloseOutlined />} onClick={() => onCancel(item.uid)}>{t('converter.actions.cancel')}</Button>}
        {finished && <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onRemove(item.uid)} aria-label={t('converter.actions.remove')} />}
      </div>
    </li>
  );
}

export default memo(FileItem);
