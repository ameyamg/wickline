// Backtesting over a date range (the Strategy Tester's From / To): a chart's bars between two dates,
// whatever the chart itself has loaded. What this computer doesn't have yet downloads first (crypto
// from Binance's archive, US stocks with an Alpaca key), and its progress is reported; then the bars
// come from that downloaded history a window at a time, or, where there's none (an hour or longer,
// other exchanges), from the exchange's API a page at a time going back.

import { createFeed } from './datafeed.js';
import { historyReady, startDownload, followDownload, cancelDownload } from './history.js';

/** Most API pages (about 1,000 bars each) fetched going back, where there's no downloaded history. */
export const MAX_PAGES = 400;
/** Bars asked for per window of downloaded history (the server's most). */
const WINDOW = 50000;

export class RangeCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'RangeCancelled'; }
}

const DEPS = { createFeed, historyReady, startDownload, followDownload, cancelDownload };

/**
 * The bars of `symbol` on `tf` (a timeframe object) from `from` to `to` (chart time, as on the chart's
 * time axis; both included), oldest first. They start later, or end earlier, when the data doesn't
 * reach that far. onStep(step) as it goes:
 *   { step: 'download', done, total, bytes }  months downloaded so far (and their size)
 *   { step: 'load', bars }                     bars gathered so far
 * `run.cancel()` stops it: it then throws RangeCancelled (a download stops too; what it got is kept).
 * `deps` replaces the feed and the history calls (tests).
 */
export async function loadRangeBars(symbol, tf, from, to, { onStep = () => {}, run = {}, deps = {} } = {}) {
  const d = { ...DEPS, ...deps };
  let cancelled = false;
  let downloadId = null;
  run.cancel = () => {
    cancelled = true;
    if (downloadId != null) d.cancelDownload(downloadId).catch(() => {});
  };
  const check = () => { if (cancelled) throw new RangeCancelled(); };
  const f = d.createFeed(symbol, tf);
  try {
    const init = await f.loadInitial();
    check();
    const newest = init?.bars || [];

    // 1. Download what's missing, with progress (it also shows in the status bar's downloads).
    if (await d.historyReady()) {
      // Chart time → UTC: crypto charts show local time (shift), stocks their exchange's (tzOffset).
      // A day either side covers that whatever it is.
      const off = f.shift ?? init?.meta?.tzOffset ?? 0;
      try {
        ({ id: downloadId } = await d.startDownload(symbol, tf.id, from - off - 86400, to - off + 86400));
      } catch (e) {
        if (e.status !== 400) throw e; // 400: nothing to download for this chart (its API pages it instead)
      }
      check();
      if (downloadId != null) {
        // A top-up (only this month's newest bars, the rest is here) isn't shown as a download.
        const job = await d.followDownload(downloadId, (j) => { if (!cancelled && !j.topUp) onStep({ step: 'download', done: j.done, total: j.total, bytes: j.bytes }); });
        downloadId = null;
        check();
        if (job.state === 'error') throw new Error(job.error || 'download failed');
      }
    }

    // 2a. Forward from `from`, a window at a time, from downloaded history.
    let w = f.loadWindow ? await f.loadWindow(from, WINDOW) : null;
    check();
    if (w) {
      const bars = [];
      while (w) {
        const last = bars.length ? bars[bars.length - 1].time : -Infinity;
        for (const b of w.bars) if (b.time > last && b.time >= from && b.time <= to) bars.push(b);
        onStep({ step: 'load', bars: bars.length });
        const end = w.bars.length ? w.bars[w.bars.length - 1].time : null;
        if (!w.more || end == null || end >= to) break;
        w = await f.loadWindow(end + tf.sec, WINDOW);
        check();
      }
      // The newest bars may not be downloaded yet (this month on an exchange): the chart's own fill in.
      const last = bars.length ? bars[bars.length - 1].time : -Infinity;
      for (const b of newest) if (b.time > last && b.time >= from && b.time <= to) bars.push(b);
      return bars;
    }

    // 2b. Back from the newest bars, a page at a time from the API. Not for stocks on the static
    // website, whose older bars cost Twelve Data credits.
    const pages = [newest];
    let oldest = newest.length ? newest[0].time : null;
    let count = newest.length;
    if (f.server !== false) {
      for (let k = 0; k < MAX_PAGES && oldest != null && oldest > from && f.canLoadMore !== false; k++) {
        const older = (await f.loadOlder(oldest, { from })).filter((b) => b.time < oldest);
        check();
        if (!older.length) break;
        pages.unshift(older);
        oldest = older[0].time;
        count += older.length;
        onStep({ step: 'load', bars: count });
      }
    }
    return pages.flat().filter((b) => b.time >= from && b.time <= to);
  } finally {
    run.alpacaHint = !!f.alpacaHint; // a US stock on Yahoo's short history: a free Alpaca key would give years more
    f.close?.();
  }
}

/** How long a backtest of `n` bars may run: 1 s per 20,000 bars, at least 10 s, at most 5 minutes (a chart's runs get 3 s). */
export const rangeTimeout = (n) => Math.min(300000, Math.max(10000, Math.round(n / 20)));
