# frontend/src

| File | Purpose |
| --- | --- |
| `main.jsx` | Browser entry: hydrates the pre-rendered HTML (or renders from scratch in dev). |
| `entry-server.jsx` | Server entry used by the pre-render: renders a URL to HTML + Ant Design CSS + head tags. |
| `App.jsx` | Routes. Arabic at `/`, `/pdf-to-word/`, `/arabic-pdf-to-word/`, `/scanned-pdf-to-word/`, `/privacy/`; English under `/en/…`. |
| `index.css` | Tailwind setup, CSS layer order, eye-comfort palette (overrides of the Tailwind tokens), hero/side-bar/glass styles, animations. |

Folders: [`components/`](components/README.md), [`pages/`](pages/README.md), [`lib/`](lib/README.md), [`i18n/`](i18n/README.md).
