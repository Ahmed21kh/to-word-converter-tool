// Runs before first paint (kept external so a strict CSP can stay free of inline scripts).
// Stored value: "light" | "dark" | "system" (default: follow the operating system).
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var dark = saved === 'dark' || ((saved !== 'light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) { /* storage unavailable: fall back to light */ }
})();
