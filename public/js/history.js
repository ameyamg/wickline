// Downloaded history, from the page's side (the server keeps it: lib/history.mjs): older bars for
// charts, downloads and their progress, and the settings. Only with the app's own server
// (env.js hasHistory()); every call carries X-Wickline, which the server requires.

import { apiUrl, dataMode, hasHistory } from './env.js';

const HEADERS = { 'X-Wickline': '1' };

async function call(path, body) {
  const init = body === undefined ? { headers: HEADERS } : { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(apiUrl(`api/history/${path}`), init);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: r.status, code: j?.code });
  return j;
}

/** Whether downloaded history works here (resolves once the server has been found, or not). */
export const historyReady = async () => (await dataMode()) === 'server' && hasHistory();

/**
 * Crypto: the chart's base-interval bars (UTC seconds) before `before` (UTC): about `count`, or back
 * to `from`. → { bars, done, ask } (ask: { from, bytes, months } when that would be a big download).
 */
export async function cryptoOlder(symbol, tf, before, { count = 2000, from = null } = {}) {
  const q = new URLSearchParams({ symbol, tf, before: String(Math.floor(before)), count: String(count) });
  if (from != null) q.set('from', String(Math.floor(from)));
  const r = await call(`bars?${q}`);
  return { ...r, bars: r.bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })) };
}

/**
 * Stocks and the rest of Yahoo: older bars ready to show, before `before` (chart time) → { bars, done, ask };
 * or, forward, the ones from `from` on (a replay's window) → { bars, more, ask }.
 */
export function yahooOlder(symbol, tf, before, { prepost = false, count = 1500, from = null, forward = false } = {}) {
  const q = new URLSearchParams({ symbol, tf, count: String(count), prepost: prepost ? '1' : '0' });
  if (before != null) q.set('before', String(Math.floor(before)));
  if (from != null) q.set('from', String(Math.floor(from)));
  if (forward) q.set('forward', '1');
  return call(`older?${q}`);
}

/** Crypto: base-interval bars (UTC) from `from` (UTC) on, oldest first: a replay's window. → { bars, more, ask } */
export async function cryptoWindow(symbol, tf, from, count = 5000) {
  const q = new URLSearchParams({ symbol, tf, from: String(Math.floor(from)), count: String(count), forward: '1' });
  const r = await call(`bars?${q}`);
  return { ...r, bars: r.bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })) };
}

/** Opening a chart: its last months download quietly. */
export function prefetchHistory(symbol, tf, prepost = false) {
  return call('prefetch', { symbol, tf, prepost: !!prepost }).then(() => watchDownloads()).catch(() => {});
}

/** Downloads a chart's history from `from` to `to` (UTC seconds; to: now) in the background. → { id } */
export async function startDownload(symbol, tf, from, to = null) {
  const r = await call('download', { symbol, tf, from: Math.floor(from), ...(to != null ? { to: Math.ceil(to) } : {}) });
  watchDownloads();
  return r;
}

export const cancelDownload = (id) => call('cancel', { id }).finally(() => watchDownloads());
export const deleteHistory = (symbol = null) => call('delete', symbol ? { symbol } : {}).then((s) => { publish(s); return s; });
/** { auto?, capGB?, alpaca?: { keyId, secret } | null } → the status (alpacaError when the key didn't work). */
export const saveHistorySettings = (patch) => call('settings', patch).then((s) => { publish(s); return s; });
export const historyStatus = () => call('status');

// --- watching downloads: the status is polled while any runs, and sent to the listeners ---------

const listeners = new Set();
let timer = null;
let last = null;
const running = (s) => s?.jobs?.some((j) => j.state === 'queued' || j.state === 'running');

function publish(s) {
  last = s;
  for (const fn of listeners) fn(s);
}

/** fn(status) on every change; → a function that stops it. */
export function onHistoryStatus(fn) {
  listeners.add(fn);
  if (last) fn(last);
  return () => listeners.delete(fn);
}

export function watchDownloads() {
  if (timer) return;
  const tick = async () => {
    try { publish(await historyStatus()); } catch { timer = null; return; }
    timer = running(last) ? setTimeout(tick, 1500) : null;
  };
  timer = setTimeout(tick, 250);
}

/**
 * Follows one download until it ends: onProgress(job) on every status ({ done, total, bytes, … }), then
 * → the job as it ended (state 'done', 'error' or 'cancelled'). Asks the server each time, so a status
 * from before the job started can't pass for its end.
 */
export async function followDownload(id, onProgress = () => {}, { every = 700 } = {}) {
  for (;;) {
    const s = await historyStatus();
    publish(s);
    const j = s.jobs.find((x) => x.id === id);
    if (j) onProgress(j);
    if (!j || j.state === 'done' || j.state === 'error' || j.state === 'cancelled') return j || { id, state: 'done' };
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Resolves with a download's last state once it has ended ('done', 'error' or 'cancelled'). */
export const whenDownloaded = (id) => followDownload(id, undefined, { every: 1500 }).then((j) => j.state, () => 'error');

/** "140 MB", "820 KB", "1.4 GB" */
export function formatBytes(n, locale) {
  const f = (v, d) => v.toLocaleString(locale, { maximumFractionDigits: d });
  if (n >= 1e9) return `${f(n / 1e9, 1)} GB`;
  if (n >= 1e6) return `${f(n / 1e6, n >= 1e8 ? 0 : 1)} MB`;
  return `${f(Math.max(1, Math.round(n / 1e3)), 0)} KB`;
}
