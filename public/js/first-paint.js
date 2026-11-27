// Runs before the page is drawn (a plain script in <head>, not a module): the saved light/dark
// theme and the user's theme colors, saved by js/theme.js, so the first paint already has them.
// A file of its own because the page's Content-Security-Policy allows no inline scripts.
try {
  const t = JSON.parse(localStorage.getItem('wickline.theme')); if (t === 'light') document.documentElement.dataset.theme = 'light';
  const p = JSON.parse(localStorage.getItem('wickline.paint'));
  if (p && p.mode === (t === 'light' ? 'light' : 'dark')) for (const k in p.vars) document.documentElement.style.setProperty(k, p.vars[k]);
} catch {}
