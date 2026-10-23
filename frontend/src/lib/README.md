# frontend/src/lib

| File | Purpose |
| --- | --- |
| `api.js` | Backend client: capabilities, upload with progress (XHR), job follow-up (SSE → polling fallback), report, preview, download URL, delete. |
| `useConversions.js` | Hook that owns the conversion queue: max 2 parallel uploads, job subscriptions, cancel / retry / remove / clear with exit animation. |
| `seo.js` | `buildHead()` (pure; titles, meta, canonical, hreflang, Open Graph, JSON-LD), `renderHeadTags()` for the pre-render, `applyHead()` for client-side navigation. |
| `format.js` | File size / duration formatting and file-kind detection. |
