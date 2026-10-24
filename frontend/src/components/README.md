# frontend/src/components

| File | Purpose |
| --- | --- |
| `Theme.jsx` | Theme provider: **light / dark / system** (stored in `localStorage`, follows the OS in system mode, toggles the `dark` class used by Tailwind) and Ant Design `ConfigProvider` (RTL/LTR, locale, colour tokens, CSS layers). |
| `Layout.jsx` | Logo, **glass navbar**, theme switch, language switch, slide-in **side bar** (blurred backdrop + gradient) for small screens, footer. |
| `ConverterCard.jsx` | The converter: drop zone, options panel, file list; opens the preview and report panels. |
| `FileItem.jsx` | One file row: upload/conversion progress, ETA, status, summary, Preview / Report / Download / Cancel / Retry. |
| `PreviewDrawer.jsx` | In-app preview of the converted document (paged, zoom, RTL-safe, verses and uncertain words highlighted) with a Download button. When the backend has `PUBLIC_URL` set, a second tab embeds Microsoft's read-only Word viewer (after a privacy confirmation). |
| `ReportDrawer.jsx` | Conversion report: statistics, Quran findings (before/after), pages needing review, per-page table. |
| `Sections.jsx` | Landing sections: Hero, Article, Features, HowItWorks, Faq, Cta. |
| `Reveal.jsx` | Scroll-reveal wrapper (content stays visible without JavaScript / for SSR). |

`PreviewDrawer` and `ReportDrawer` are lazy-loaded.
