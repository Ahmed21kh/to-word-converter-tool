// Thin client for the backend API. Upload uses XHR because fetch cannot report upload progress.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const TERMINAL = ['done', 'error', 'cancelled'];

export const downloadUrl = (id) => `${BASE}/api/jobs/${id}/download`;

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

export async function getCapabilities() {
  const caps = await json(await fetch(`${BASE}/api/capabilities`));
  // a restarting server or a wrong URL can answer with something that is not the capabilities document
  if (!Array.isArray(caps.accept) || !Array.isArray(caps.outputs)) throw new Error('Unexpected capabilities response');
  return caps;
}

export async function getReport(id) {
  return json(await fetch(`${BASE}/api/jobs/${id}/report`));
}

export async function getJob(id) {
  return json(await fetch(`${BASE}/api/jobs/${id}`));
}

export async function deleteJob(id) {
  await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
}

/** @returns {{promise: Promise<object>, abort: () => void}} */
export function uploadFile(file, options, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('options', JSON.stringify(options));
    xhr.open('POST', `${BASE}/api/convert`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(Object.assign(new Error(body.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('network'), { network: true }));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * Follow a job with Server-Sent Events; fall back to polling if the stream breaks.
 * @returns {() => void} unsubscribe
 */
export function subscribeJob(id, onUpdate) {
  let closed = false;
  let es = null;
  let timer = null;

  const handle = (job) => {
    if (closed) return;
    onUpdate(job);
    if (TERMINAL.includes(job.status)) stop();
  };
  const poll = async () => {
    if (closed) return;
    try {
      handle(await getJob(id));
    } catch (err) {
      if (err.status === 404) {
        handle({ id, status: 'error', error: 'expired' });
        return;
      }
    }
    if (!closed) timer = setTimeout(poll, 2000);
  };
  function stop() {
    closed = true;
    es?.close();
    clearTimeout(timer);
  }

  if (typeof EventSource === 'undefined') poll();
  else {
    es = new EventSource(`${BASE}/api/jobs/${id}/events`);
    es.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      if (closed) return;
      es.close();
      es = null;
      poll();
    };
  }
  return stop;
}

export const previewImageUrl = (id, name) => `${BASE}/api/jobs/${id}/preview/images/${encodeURIComponent(name)}`;

export async function getPreview(id, from = 1, count = 3) {
  return json(await fetch(`${BASE}/api/jobs/${id}/preview?from=${from}&count=${count}`));
}
