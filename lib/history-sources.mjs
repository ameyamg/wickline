// Where downloaded history comes from (lib/history.mjs keeps it in lib/history-store.mjs):
//  - Binance and Binance Futures: Binance's public archive (data.binance.vision), one zip per symbol,
//    interval and finished month, with a SHA-256 checksum; the current month from the REST API.
//  - Alpaca (US stocks and ETFs, with the user's own free key): 1-minute bars since 2016.
// Pure helpers are exported for test/history-sources.test.mjs; the fetchers take a fetch function so
// the tests can feed them recorded answers.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { monthBounds } from './history-store.mjs';
import { tzOffset } from './tz.mjs';

const UA = 'Wickline (https://github.com/keptaduona/wickline)';

// ---------------------------------------------------------------------------
// Zip: the archive's files hold one CSV each. Read it from the central directory (the sizes there
// are always right, also when the local header leaves them to a trailing descriptor).
// ---------------------------------------------------------------------------

export function unzipFirst(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Bad zip directory');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Bad zip entry');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported zip compression ${method}`);
}

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

const BINANCE = {
  binance: { archive: 'spot', rest: ['https://data-api.binance.vision', 'https://api.binance.com'], klines: '/api/v3/klines' },
  binancef: { archive: 'futures/um', rest: ['https://fapi.binance.com'], klines: '/fapi/v1/klines' },
};
export const isBinanceProvider = (p) => Object.hasOwn(BINANCE, p);

/** The archive zip of one month: …/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2024-01.zip */
export function binanceArchiveUrl(provider, symbol, interval, ym) {
  return `https://data.binance.vision/data/${BINANCE[provider].archive}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`;
}

/**
 * The archive's CSV -> bars (UTC seconds). Open times are milliseconds, or microseconds in spot files
 * from 2025 on; futures files start with a header row.
 */
export function parseBinanceCsv(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.split(',');
    const t = Number(f[0]);
    if (!Number.isFinite(t) || f.length < 6) continue; // header or empty line
    out.push({ time: Math.floor(t > 1e14 ? t / 1e6 : t / 1e3), open: +f[1], high: +f[2], low: +f[3], close: +f[4], volume: +f[5] });
  }
  return out;
}

const intervalSec = (iv) => {
  const m = /^(\d+)([mhdw])$/.exec(iv);
  return m ? +m[1] * { m: 60, h: 3600, d: 86400, w: 604800 }[m[2]] : 0;
};

async function getJsonFrom(fetchFn, urls, signal) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(20000) });
      if (r.ok) return r.json();
      last = Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      if (r.status === 400) break; // a bad symbol is bad on every host
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Klines from the REST API, startSec <= time < endSec (1000 a page). */
export async function binanceRest(provider, symbol, interval, startSec, endSec, { fetchFn = fetch, signal } = {}) {
  const cfg = BINANCE[provider];
  const step = intervalSec(interval);
  const out = [];
  let from = startSec;
  while (from < endSec) {
    const q = `${cfg.klines}?symbol=${symbol}&interval=${interval}&startTime=${from * 1000}&endTime=${endSec * 1000 - 1}&limit=1000`;
    const rows = await getJsonFrom(fetchFn, cfg.rest.map((h) => h + q), signal);
    for (const k of rows) out.push({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    if (rows.length < 1000) break;
    from = Math.floor(rows[rows.length - 1][0] / 1000) + step;
  }
  return out;
}

/** When the symbol's first bar opened (UTC seconds), or null if it has none. */
export async function binanceFirstBar(provider, symbol, interval, opts = {}) {
  const cfg = BINANCE[provider];
  const rows = await getJsonFrom(opts.fetchFn || fetch, cfg.rest.map((h) => `${h}${cfg.klines}?symbol=${symbol}&interval=${interval}&startTime=0&limit=1`), opts.signal);
  return rows.length ? Math.floor(rows[0][0] / 1000) : null;
}

/**
 * One month of bars: a finished month from the archive (checked against its SHA-256), the current
 * one (or a finished one the archive hasn't published yet: it does in the first days of the next
 * month) from the REST API. → { bars, complete, bytes } (bytes: what was downloaded).
 */
export async function binanceMonth(provider, symbol, interval, ym, { fetchFn = fetch, now = Date.now() / 1000, signal } = {}) {
  const { start, end } = monthBounds(ym);
  if (end > now - 3600) { // this month, or one that only just ended
    const bars = await binanceRest(provider, symbol, interval, start, Math.min(end, Math.floor(now)), { fetchFn, signal });
    return { bars, complete: end <= now - intervalSec(interval), bytes: bars.length * 60 };
  }
  const url = binanceArchiveUrl(provider, symbol, interval, ym);
  const r = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(120000) });
  if (r.status === 404) {
    // Not in the archive: not published yet (a recent month), or the symbol wasn't trading then.
    const bars = await binanceRest(provider, symbol, interval, start, end, { fetchFn, signal });
    return { bars, complete: true, bytes: bars.length * 60 };
  }
  if (!r.ok) throw Object.assign(new Error(`Binance archive: HTTP ${r.status}`), { status: r.status });
  const zip = Buffer.from(await r.arrayBuffer());
  const sum = await fetchFn(`${url}.CHECKSUM`, { headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(20000) }).then((x) => (x.ok ? x.text() : '')).catch(() => '');
  const want = /^[0-9a-f]{64}/i.exec(sum.trim())?.[0];
  if (want && createHash('sha256').update(zip).digest('hex') !== want.toLowerCase()) throw new Error('Binance archive: checksum mismatch');
  return { bars: parseBinanceCsv(unzipFirst(zip).toString('utf8')), complete: true, bytes: zip.length };
}

// ---------------------------------------------------------------------------
// US market hours (New York time, with daylight saving)
// ---------------------------------------------------------------------------

/** New York's UTC offset (seconds, -14400 or -18000) on the UTC day holding t. */
export const nyOffset = (t) => tzOffset('America/New_York', t);

/** Whether a 1-minute bar at UTC time t is in the regular session (9:30-16:00 New York), or with ext in 4:00-20:00. */
export function inUsSession(t, ext = false) {
  const local = (((t + nyOffset(t)) % 86400) + 86400) % 86400;
  return ext ? local >= 4 * 3600 && local < 20 * 3600 : local >= 9.5 * 3600 && local < 16 * 3600;
}

// ---------------------------------------------------------------------------
// Alpaca (https://docs.alpaca.markets): 1-minute bars of US stocks and ETFs since 2016, with the
// user's own free key. The free plan has full-market (SIP) bars except the last 15 minutes, and
// 200 requests a minute.
// ---------------------------------------------------------------------------

export const ALPACA_SINCE = Date.UTC(2016, 0, 1) / 1000;

/** The Alpaca symbol of a Yahoo one, or null if it isn't a US stock or ETF ticker: BRK-B -> BRK.B. */
export function alpacaSymbol(yahoo) {
  return /^[A-Z]{1,5}(-[A-Z])?$/.test(yahoo) ? yahoo.replace('-', '.') : null;
}

const alpacaCalls = [];
async function alpacaPace() {
  // At most 190 requests in any minute (the limit is 200).
  for (;;) {
    const now = Date.now();
    while (alpacaCalls.length && now - alpacaCalls[0] > 60000) alpacaCalls.shift();
    if (alpacaCalls.length < 190) { alpacaCalls.push(now); return; }
    await new Promise((r) => setTimeout(r, 60000 - (now - alpacaCalls[0]) + 50));
  }
}

/**
 * 1-minute bars of a US stock, startSec <= time < endSec (UTC seconds), split-adjusted like Yahoo's,
 * pre-market and after-hours included. keys: { keyId, secret }. A wrong key throws { code: 'alpaca-auth' }.
 */
export async function alpacaBars(symbol, startSec, endSec, keys, { fetchFn = fetch, now = Date.now() / 1000, signal } = {}) {
  const end = Math.min(endSec, Math.floor(now - 16 * 60)); // the free plan: nothing from the last 15 minutes
  const out = [];
  if (end <= startSec) return out;
  let page = null;
  for (let k = 0; k < 500; k++) {
    const q = new URLSearchParams({ timeframe: '1Min', start: new Date(startSec * 1000).toISOString(), end: new Date(end * 1000).toISOString(), limit: '10000', adjustment: 'split', feed: 'sip', sort: 'asc' });
    if (page) q.set('page_token', page);
    await alpacaPace();
    const r = await fetchFn(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, {
      headers: { 'APCA-API-KEY-ID': keys.keyId, 'APCA-API-SECRET-KEY': keys.secret, 'User-Agent': UA },
      signal: signal ?? AbortSignal.timeout(30000),
    });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Alpaca refused the key'), { code: 'alpaca-auth', status: r.status });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 5000)); k--; continue; }
    if (r.status === 422 || r.status === 404) return out; // not a symbol Alpaca has
    if (!r.ok) throw Object.assign(new Error(`Alpaca: HTTP ${r.status}`), { status: r.status });
    const j = await r.json();
    for (const b of j.bars || []) out.push({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    page = j.next_page_token;
    if (!page) break;
  }
  return out;
}

/** One month of an Alpaca symbol's 1-minute bars → { bars, complete, bytes }. */
export async function alpacaMonth(symbol, ym, keys, opts = {}) {
  const now = opts.now ?? Date.now() / 1000;
  const { start, end } = monthBounds(ym);
  const bars = await alpacaBars(symbol, start, end, keys, { ...opts, now });
  return { bars, complete: end <= now - 16 * 60, bytes: bars.length * 60 };
}
