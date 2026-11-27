// Where downloaded history comes from (lib/history-sources.mjs), with recorded answers instead of the
// network. Run: node test/history-sources.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { unzipFirst, parseBinanceCsv, binanceArchiveUrl, binanceMonth, inUsSession, nyOffset, alpacaSymbol, alpacaBars } from '../lib/history-sources.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`  ok ${name}`); };
const T = (s) => Date.parse(s) / 1000;

/** A one-file zip, the way the archive writes them (deflated). */
function makeZip(name, text) {
  const data = zlib.deflateRawSync(Buffer.from(text));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(text.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, cd, nameBuf, eocd]);
}

/** A fetch that answers from a table: url -> { status, body }. Records the urls asked. */
function fakeFetch(table) {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    const hit = typeof table === 'function' ? table(url) : Object.entries(table).find(([k]) => url.startsWith(k))?.[1];
    const status = hit?.status ?? (hit ? 200 : 404);
    const body = hit?.body ?? '';
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => String(body),
      arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    };
  };
  fn.asked = asked;
  return fn;
}

await ok('a one-file zip is read back', () => {
  const csv = 'a,b\n1,2\n'.repeat(500);
  assert.equal(unzipFirst(makeZip('x.csv', csv)).toString(), csv);
  assert.throws(() => unzipFirst(Buffer.from('not a zip')), /zip/);
});

await ok('archive rows: milliseconds, microseconds (spot from 2025) and a header row (futures)', () => {
  const ms = '1704067200000,42283.58,42298.62,42261.02,42298.61,35.9,1704067259999,1519031.6,132,1,1,0\n';
  const us = '1748736000000000,104591.88,104647.11,104591.88,104647.0,3.5,1748736059999999,1,1,1,1,0\n';
  const head = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n';
  const bars = parseBinanceCsv(head + ms + us + '\n');
  assert.deepEqual(bars.map((b) => b.time), [1704067200, 1748736000]);
  assert.deepEqual(bars[0], { time: 1704067200, open: 42283.58, high: 42298.62, low: 42261.02, close: 42298.61, volume: 35.9 });
  assert.equal(binanceArchiveUrl('binancef', 'BTCUSDT', '1m', '2024-01'), 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2024-01.zip');
});

await ok('a finished month comes from the archive and is checked against its checksum', async () => {
  const csv = '1704067200000,1,2,0.5,1.5,10,0,0,0,0,0,0\n1704067260000,1.5,2,1,1.8,11,0,0,0,0,0,0\n';
  const zip = makeZip('BTCUSDT-1m-2024-01.csv', csv);
  const sum = createHash('sha256').update(zip).digest('hex');
  const url = binanceArchiveUrl('binance', 'BTCUSDT', '1m', '2024-01');
  const good = fakeFetch((u) => (u === url ? { body: zip } : u === `${url}.CHECKSUM` ? { body: `${sum}  BTCUSDT-1m-2024-01.zip\n` } : null));
  const m = await binanceMonth('binance', 'BTCUSDT', '1m', '2024-01', { fetchFn: good, now: T('2026-11-27T00:00:00Z') });
  assert.equal(m.complete, true);
  assert.deepEqual(m.bars.map((b) => b.close), [1.5, 1.8]);
  assert.equal(m.bytes, zip.length);
  const bad = fakeFetch((u) => (u === url ? { body: zip } : u === `${url}.CHECKSUM` ? { body: `${'0'.repeat(64)}  x.zip` } : null));
  await assert.rejects(binanceMonth('binance', 'BTCUSDT', '1m', '2024-01', { fetchFn: bad, now: T('2026-11-27T00:00:00Z') }), /checksum/);
});

await ok('a month missing from the archive, and the current month, come from the REST API', async () => {
  const k = (t, c) => [t * 1000, String(c), String(c), String(c), String(c), '1'];
  const api = fakeFetch((u) => (u.includes('data.binance.vision') ? { status: 404 } : u.includes('/api/v3/klines') ? { body: [k(T('2026-11-01T00:00:00Z'), 7)] } : null));
  const cur = await binanceMonth('binance', 'BTCUSDT', '1m', '2026-11', { fetchFn: api, now: T('2026-11-27T12:00:00Z') });
  assert.equal(cur.complete, false, 'the current month is never complete');
  assert.equal(cur.bars[0].close, 7);
  assert.ok(!api.asked.some((u) => u.includes('data.binance.vision')), 'the current month is not in the archive');
  const old = await binanceMonth('binance', 'NEWCOIN', '1m', '2019-03', { fetchFn: fakeFetch((u) => (u.includes('/api/v3/klines') ? { body: [] } : null)), now: T('2026-11-27T12:00:00Z') });
  assert.deepEqual(old, { bars: [], complete: true, bytes: 0 }, 'before the symbol traded: an empty, complete month');
});

await ok('US market hours follow New York time through daylight saving', () => {
  assert.equal(nyOffset(T('2024-07-01T15:00:00Z')), -4 * 3600);
  assert.equal(nyOffset(T('2024-01-02T15:00:00Z')), -5 * 3600);
  assert.equal(inUsSession(T('2024-07-01T13:30:00Z')), true, '9:30 in summer');
  assert.equal(inUsSession(T('2024-07-01T13:29:00Z')), false);
  assert.equal(inUsSession(T('2024-01-02T14:30:00Z')), true, '9:30 in winter');
  assert.equal(inUsSession(T('2024-01-02T20:59:00Z')), true, '15:59');
  assert.equal(inUsSession(T('2024-01-02T21:00:00Z')), false, '16:00');
  assert.equal(inUsSession(T('2024-01-02T21:00:00Z'), true), true, 'after-hours with ext');
  assert.equal(inUsSession(T('2024-01-02T08:59:00Z'), true), false, 'before 4:00');
});

await ok('Alpaca: US tickers only, pages followed, the last 15 minutes left out, a wrong key reported', async () => {
  assert.equal(alpacaSymbol('AAPL'), 'AAPL');
  assert.equal(alpacaSymbol('BRK-B'), 'BRK.B');
  for (const s of ['EURUSD=X', '^GSPC', 'SAP.DE', 'BTC-USD', 'GC=F']) assert.equal(alpacaSymbol(s), null, s);
  const now = T('2024-03-05T15:00:00Z');
  const pages = fakeFetch((u) => {
    const q = new URL(u).searchParams;
    if (q.get('page_token') === 'p2') return { body: { bars: [{ t: '2024-03-05T14:31:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }], next_page_token: null } };
    return { body: { bars: [{ t: '2024-03-05T14:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }], next_page_token: 'p2' } };
  });
  const bars = await alpacaBars('AAPL', T('2024-03-05T14:00:00Z'), T('2024-03-05T16:00:00Z'), { keyId: 'k', secret: 's' }, { fetchFn: pages, now });
  assert.deepEqual(bars.map((b) => b.close), [1, 2]);
  assert.equal(new URL(pages.asked[0]).searchParams.get('end'), new Date((now - 16 * 60) * 1000).toISOString(), 'ends 16 minutes ago');
  assert.equal(new URL(pages.asked[0]).searchParams.get('feed'), 'sip');
  await assert.rejects(alpacaBars('AAPL', T('2024-03-04T00:00:00Z'), T('2024-03-05T00:00:00Z'), { keyId: 'k', secret: 'bad' }, { fetchFn: fakeFetch(() => ({ status: 403 })), now }), (e) => e.code === 'alpaca-auth');
});

console.log(`history-sources: ${n} checks passed`);
