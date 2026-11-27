// The Strategy Tester's date range (public/js/range-test.js): missing history downloads first with
// its progress, then the range's bars load forward from downloaded history, or back from the API.
// A fake feed and fake history calls stand in for the network. Run: node test/range-test.test.mjs
import assert from 'node:assert/strict';
import { loadRangeBars, RangeCancelled, MAX_PAGES, rangeTimeout } from '../public/js/range-test.js';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`  ok ${name}`); };

const MIN = 60, DAY = 86400;
const T0 = 1_700_000_000 - (1_700_000_000 % DAY); // a midnight
const bar = (time) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
const series = (from, to, step = MIN) => { const out = []; for (let t = from; t <= to; t += step) out.push(bar(t)); return out; };
const tf1m = { id: '1m', sec: MIN };

/** A feed whose downloaded history is `stored` and whose newest bars are `newest`. */
function windowFeed(stored, newest, log = []) {
  return {
    shift: 0,
    async loadInitial() { return { meta: {}, bars: newest }; },
    async loadWindow(from, count) {
      log.push(['window', from, count]);
      const i = stored.findIndex((b) => b.time >= from);
      if (i < 0) return { bars: [], more: false };
      const bars = stored.slice(i, i + 1000); // small windows, so the loop pages
      return { bars, more: i + 1000 < stored.length };
    },
    close() { log.push(['close']); },
  };
}

const history = (over = {}) => ({
  historyReady: async () => true,
  startDownload: async () => ({ id: 7 }),
  followDownload: async (id, onProgress) => { onProgress({ done: 1, total: 3, bytes: 2e6 }); onProgress({ done: 3, total: 3, bytes: 6e6 }); return { id, state: 'done' }; },
  cancelDownload: async () => {},
  ...over,
});

await ok('downloads what is missing (reporting months and bytes), then loads the range forward, a window at a time', async () => {
  const stored = series(T0, T0 + 3 * DAY);
  const newest = series(T0 + 3 * DAY - 10 * MIN, T0 + 3 * DAY + 50 * MIN); // overlaps, then goes past what's stored
  const log = [];
  const steps = [];
  let asked = null;
  const bars = await loadRangeBars('BINANCE:BTCUSDT', tf1m, T0 + DAY, T0 + 4 * DAY, {
    onStep: (s) => steps.push(s),
    deps: { createFeed: () => windowFeed(stored, newest, log), ...history({ startDownload: async (...a) => { asked = a; return { id: 7 }; } }) },
  });
  assert.deepEqual(asked, ['BINANCE:BTCUSDT', '1m', T0 + DAY - DAY, T0 + 4 * DAY + DAY], 'a day either side, in UTC');
  assert.deepEqual(steps.filter((s) => s.step === 'download'), [{ step: 'download', done: 1, total: 3, bytes: 2e6 }, { step: 'download', done: 3, total: 3, bytes: 6e6 }]);
  assert.ok(steps.some((s) => s.step === 'load' && s.bars > 0), 'and how many bars it has');
  assert.equal(bars[0].time, T0 + DAY);
  assert.equal(bars[bars.length - 1].time, T0 + 3 * DAY + 50 * MIN, 'the newest bars fill in after what was downloaded');
  assert.ok(bars.every((b, i) => i === 0 || b.time - bars[i - 1].time === MIN), 'no gaps and no repeats');
  assert.ok(log.filter(([k]) => k === 'window').length > 2, 'several windows');
  assert.deepEqual(log.at(-1), ['close'], 'the feed is closed after');
});

await ok('stops at `to`, and a chart with nothing to download (400) just loads', async () => {
  const stored = series(T0, T0 + 3 * DAY);
  const bars = await loadRangeBars('YAHOO:AAPL', tf1m, T0, T0 + DAY, {
    deps: { createFeed: () => windowFeed(stored, []), ...history({ startDownload: async () => { throw Object.assign(new Error('no'), { status: 400 }); } }) },
  });
  assert.equal(bars[0].time, T0);
  assert.equal(bars[bars.length - 1].time, T0 + DAY);
});

await ok('without downloaded history (an hour or longer, other exchanges): back from the newest bars, a page at a time', async () => {
  const H = 3600, all = series(T0, T0 + 200 * H, H);
  let pages = 0;
  const feed = {
    shift: 0,
    async loadInitial() { return { meta: {}, bars: all.slice(-50) }; },
    async loadOlder(first) { pages++; const i = all.findIndex((b) => b.time >= first); return all.slice(Math.max(0, i - 40), i); },
    close() {},
  };
  const steps = [];
  const bars = await loadRangeBars('BINANCE:BTCUSDT', { id: '1h', sec: H }, T0 + 20 * H, T0 + 120 * H, {
    onStep: (s) => steps.push(s), deps: { createFeed: () => feed, ...history({ historyReady: async () => false }) },
  });
  assert.equal(bars.length, 101);
  assert.equal(bars[0].time, T0 + 20 * H);
  assert.equal(pages, 4, 'until the range is reached');
  assert.ok(steps.every((s) => s.step === 'load'));
});

await ok('stocks on the static website don\'t page back (that would spend Twelve Data credits)', async () => {
  let paged = false;
  const feed = { server: false, async loadInitial() { return { meta: {}, bars: series(T0, T0 + 10 * DAY, DAY) }; }, async loadOlder() { paged = true; return []; }, close() {} };
  const bars = await loadRangeBars('YAHOO:AAPL', { id: '1D', sec: DAY, daily: true }, T0 + 2 * DAY, T0 + 5 * DAY, { deps: { createFeed: () => feed, ...history({ historyReady: async () => false }) } });
  assert.equal(paged, false);
  assert.equal(bars.length, 4);
});

await ok(`at most ${MAX_PAGES} pages back`, async () => {
  let pages = 0, oldest = T0;
  const feed = {
    async loadInitial() { return { meta: {}, bars: [bar(T0)] }; },
    async loadOlder() { pages++; oldest -= MIN; return [bar(oldest)]; },
    close() {},
  };
  await loadRangeBars('OKX:BTC-USDT', tf1m, 0, T0, { deps: { createFeed: () => feed, ...history({ historyReady: async () => false }) } });
  assert.equal(pages, MAX_PAGES);
});

await ok('Cancel during the download stops it there (and cancels the download)', async () => {
  const run = {};
  let cancelled = null;
  const p = loadRangeBars('BINANCE:BTCUSDT', tf1m, T0, T0 + DAY, {
    run,
    deps: {
      createFeed: () => windowFeed(series(T0, T0 + DAY), []),
      ...history({
        followDownload: async (id) => { run.cancel(); await new Promise((r) => setTimeout(r, 10)); return { id, state: 'cancelled' }; },
        cancelDownload: async (id) => { cancelled = id; },
      }),
    },
  });
  await assert.rejects(p, RangeCancelled);
  assert.equal(cancelled, 7);
});

await ok('a download that fails stops the test with its error', async () => {
  const p = loadRangeBars('BINANCE:BTCUSDT', tf1m, T0, T0 + DAY, {
    deps: { createFeed: () => windowFeed([], []), ...history({ followDownload: async (id) => ({ id, state: 'error', error: 'HTTP 404' }) }) },
  });
  await assert.rejects(p, /HTTP 404/);
});

await ok('the time a backtest may run grows with its bars, within bounds', () => {
  assert.equal(rangeTimeout(1000), 10000);
  assert.equal(rangeTimeout(1_000_000), 50000);
  assert.equal(rangeTimeout(50_000_000), 300000);
});

console.log(`range test: ${n} checks passed`);
