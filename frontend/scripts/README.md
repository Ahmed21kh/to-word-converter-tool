# frontend/scripts

| File | Purpose |
| --- | --- |
| `prerender.mjs` | Runs after the client and server builds: renders every route to `dist/<route>/index.html` (HTML, head tags, JSON-LD, Ant Design CSS), writes `sitemap.xml` (with hreflang alternates), `robots.txt` and `404.html`. Forces `NODE_ENV=production` so Ant Design's class names match the browser bundle. |
| `generate-og.mjs` | Draws the Open Graph image and PWA icons into `public/` (`npm run og`). |
