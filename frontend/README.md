# Frontend (React)

Vite 8 + React 19 + Ant Design 6 + Tailwind CSS 4. **Arabic is the default language** (RTL), English is at `/en/`. Themes:
**light, dark and auto** (follows the device). Every page is pre-rendered to static HTML for SEO.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 - the browser calls the backend directly (VITE_API_URL in .env.development)
npm run build      # client bundle + server bundle + pre-render (dist/)
npm run og         # regenerate public/og-image.png and the PWA icons
```

| Env var (`.env`) | Meaning |
| --- | --- |
| `VITE_SITE_URL` | **Set this to your real domain before building** (used for canonical, hreflang, Open Graph, JSON-LD, sitemap). Default is a placeholder `https://pdf2word.example.com`. |
| `VITE_API_URL` | Backend address. **`.env.development` sets `http://localhost:4000`** so requests go straight to the backend port (change it if you start the backend on another `PORT`). `.env.production` leaves it empty = same origin. If the API is on another domain, add the site to the backend's `CORS_ORIGINS`. |
| `VITE_DEV_API` | Only for the (now unused) Vite `/api` proxy fallback. Default `http://localhost:4000`. |

## Features

* Drag & drop upload (several files), live progress (SSE with polling fallback), ETA, cancel / retry / remove (with fade-out).
* After conversion: **Preview** (page by page, zoom, verses in green, uncertain words in yellow), **Report**, **Download**.
* Options: output format, mode (smart / OCR / exact look), language, Quran verification, highlight uncertain words, headings, Word font.
* Glass navbar, gradient slide-in side bar (mobile), blurred panels, scroll-reveal / fade / float animations (disabled for
  *reduced motion*), eye-comfortable palette defined in `src/index.css`.

## SEO

Static pre-render of 5 pages × 2 languages with unique `<title>`, description, canonical, `hreflang` (+ `x-default`), Open Graph /
Twitter cards, JSON-LD (`WebApplication`, `FAQPage`, `BreadcrumbList`), `sitemap.xml`, `robots.txt`, a real `404.html` (noindex),
semantic headings and landmarks, skip link, self-hosted fonts, PWA manifest. The backend serves `dist/` with long-lived caching for
hashed assets.

## Folders

| Folder | Contents |
| --- | --- |
| [`src/`](src/README.md) | application code |
| [`public/`](public/README.md) | static files copied as-is |
| [`scripts/`](scripts/README.md) | build-time scripts (pre-render, OG image) |

Env files: `.env.development` (API at `http://localhost:4000`) and `.env.production` (same-origin API, `VITE_SITE_URL`).

Other files: `index.html` (template; declares the CSS layer order first so Tailwind and Ant Design never fight), `vite.config.js`
(React + Tailwind plugins, dev proxy, SSR bundling), `package.json`.
