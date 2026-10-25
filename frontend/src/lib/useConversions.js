import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadFile, subscribeJob, deleteJob, pauseJob, resumeJob, TERMINAL } from './api.js';

const MAX_PARALLEL_UPLOADS = 2;
let counter = 0;

/**
 * Conversion queue: uploads (max 2 at a time), follows each server job, exposes actions.
 * Item shape: { uid, file, name, size, options, status, uploadPct, job, error, errorKey }
 */
export function useConversions(getOptions) {
  const [items, setItems] = useState([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handles = useRef(new Map()); // uid -> { abort, unsubscribe }
  const waiting = useRef([]);
  const active = useRef(0);
  const optionsRef = useRef(getOptions);
  optionsRef.current = getOptions;

  const patch = useCallback((uid, p) => {
    setItems((list) => list.map((i) => (i.uid === uid ? { ...i, ...(typeof p === 'function' ? p(i) : p) } : i)));
  }, []);

  const pump = useCallback(() => {
    while (active.current < MAX_PARALLEL_UPLOADS && waiting.current.length) {
      const item = waiting.current.shift();
      active.current++;
      const { promise, abort } = uploadFile(item.file, item.options, (pct) => patch(item.uid, { uploadPct: pct }));
      handles.current.set(item.uid, { abort });
      promise
        .then((job) => {
          patch(item.uid, { status: job.status, job, uploadPct: 100 });
          const unsubscribe = subscribeJob(job.id, (view) => {
            patch(item.uid, (cur) => (cur.status === 'cancelled' ? {} : { job: view, status: view.status, errorKey: view.status === 'error' ? 'generic' : undefined, error: view.error || undefined }));
          });
          handles.current.set(item.uid, { unsubscribe, jobId: job.id });
        })
        .catch((err) => {
          if (err.aborted) return;
          patch(item.uid, { status: 'error', error: err.network ? null : err.message, errorKey: err.network ? 'network' : 'generic' });
        })
        .finally(() => {
          active.current--;
          pump();
        });
    }
  }, [patch]);

  const add = useCallback((files) => {
    const created = files.map((file) => ({
      uid: `f${Date.now()}-${++counter}`,
      file,
      name: file.name,
      size: file.size,
      options: { ...optionsRef.current() },
      status: 'uploading',
      uploadPct: 0,
      job: null,
      error: null,
    }));
    setItems((list) => [...created, ...list]);
    waiting.current.push(...created);
    pump();
  }, [pump]);

  const cancel = useCallback((uid) => {
    const h = handles.current.get(uid);
    waiting.current = waiting.current.filter((i) => i.uid !== uid);
    h?.abort?.();
    h?.unsubscribe?.();
    if (h?.jobId) deleteJob(h.jobId);
    handles.current.delete(uid);
    patch(uid, (cur) => (TERMINAL.includes(cur.status) ? {} : { status: 'cancelled' }));
  }, [patch]);

  // pause / go on: the server keeps the pages done so far; the row follows the job's own updates
  const setPaused = useCallback((uid, paused) => {
    const jobId = handles.current.get(uid)?.jobId;
    if (!jobId) return;
    (paused ? pauseJob : resumeJob)(jobId)
      .then((view) => patch(uid, (cur) => (TERMINAL.includes(cur.status) ? {} : { job: view, status: view.status })))
      .catch(() => {});
  }, [patch]);
  const pause = useCallback((uid) => setPaused(uid, true), [setPaused]);
  const resume = useCallback((uid) => setPaused(uid, false), [setPaused]);

  const remove = useCallback((uid) => {
    const h = handles.current.get(uid);
    waiting.current = waiting.current.filter((i) => i.uid !== uid);
    h?.abort?.();
    h?.unsubscribe?.();
    if (h?.jobId) deleteJob(h.jobId);
    handles.current.delete(uid);
    // fade the row out first, then drop it
    setItems((list) => list.map((i) => (i.uid === uid ? { ...i, leaving: true } : i)));
    setTimeout(() => setItems((list) => list.filter((i) => i.uid !== uid)), 260);
  }, []);

  // re-queue the same row in place. Side effects stay outside setItems: React (StrictMode) may run an
  // updater twice, which used to enqueue the file twice and show duplicate rows.
  const retry = useCallback((uid) => {
    const item = itemsRef.current.find((i) => i.uid === uid);
    if (!item || !['error', 'cancelled'].includes(item.status) || waiting.current.some((i) => i.uid === uid)) return;
    const h = handles.current.get(uid);
    h?.unsubscribe?.();
    if (h?.jobId) deleteJob(h.jobId);
    handles.current.delete(uid);
    const fresh = { ...item, options: { ...optionsRef.current() }, status: 'uploading', uploadPct: 0, job: null, error: null, errorKey: undefined };
    itemsRef.current = itemsRef.current.map((i) => (i.uid === uid ? fresh : i)); // blocks a fast double click
    patch(uid, fresh);
    waiting.current.push(fresh);
    pump();
  }, [patch, pump]);

  const clearFinished = useCallback(() => {
    setItems((list) => list.map((i) => (TERMINAL.includes(i.status) ? { ...i, leaving: true } : i)));
    setTimeout(() => setItems((list) => list.filter((i) => !i.leaving)), 260);
  }, []);

  useEffect(() => () => {
    for (const h of handles.current.values()) {
      h.abort?.();
      h.unsubscribe?.();
    }
  }, []);

  return { items, add, cancel, pause, resume, remove, retry, clearFinished };
}
