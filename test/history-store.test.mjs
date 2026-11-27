// Downloaded history on disk (lib/history-store.mjs). Run: node test/history-store.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore, monthOf, monthBounds, monthsBetween, safeName } from '../lib/history-store.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`  ok ${name}`); };
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wl-hist-'));
const bar = (time, c = 100) => ({ time, open: c, high: c + 1, low: c - 1, close: c, volume: 5 });
const T = (s) => Date.parse(s) / 1000;
const BTC = { provider: 'binance', symbol: 'BTCUSDT', interval: '1m' };

try {
  await ok('months: of a time, bounds, and a run of them across a year end', () => {
    assert.equal(monthOf(T('2024-02-29T23:59:00Z')), '2024-02');
    assert.deepEqual(monthBounds('2024-12'), { start: T('2024-12-01T00:00:00Z'), end: T('2025-01-01T00:00:00Z') });
    assert.deepEqual(monthsBetween('2024-11', '2025-02'), ['2024-11', '2024-12', '2025-01', '2025-02']);
    assert.deepEqual(monthsBetween('2025-03', '2025-03'), ['2025-03']);
  });

  await ok('names are safe on every system and never collide', () => {
    assert.equal(safeName('BTCUSDT'), 'BTCUSDT');
    assert.equal(safeName('EURUSD=X'), 'EURUSD~3dX');
    assert.equal(safeName('BRK.B'), 'BRK~2eB');
    assert.equal(safeName('..'), '~2e~2e');
    assert.equal(safeName('a/b\\c'), 'a~2fb~5cc');
    assert.notEqual(safeName('A.B'), safeName('A_B'));
  });

  await ok('a month is stored, merged with later writes and read back in order', async () => {
    const s = new HistoryStore(tmp);
    const t0 = T('2024-01-31T23:58:00Z');
    await s.writeMonth(BTC, '2024-01', [bar(t0 + 60, 2), bar(t0, 1), bar(T('2024-02-01T00:00:00Z'), 9)]);
    assert.deepEqual((await s.readMonth(BTC, '2024-01')).map((b) => b.close), [1, 2], 'February\'s bar is not January\'s');
    await s.writeMonth(BTC, '2024-01', [bar(t0 + 60, 3), bar(t0 - 60, 0)], { complete: true });
    assert.deepEqual((await s.readMonth(BTC, '2024-01')).map((b) => [b.time - t0, b.close]), [[-60, 0], [0, 1], [60, 3]], 'the same time is replaced');
    const idx = await new HistoryStore(tmp).index(BTC); // read back from disk
    assert.equal(idx.months['2024-01'].n, 3);
    assert.equal(idx.months['2024-01'].complete, true);
    await s.writeMonth(BTC, '2024-01', [bar(t0 - 120, 7)]);
    assert.equal((await s.index(BTC)).months['2024-01'].complete, true, 'a complete month stays complete');
  });

  await ok('a range reads across months; an empty complete month is remembered', async () => {
    const s = new HistoryStore(tmp);
    await s.writeMonth(BTC, '2024-02', [bar(T('2024-02-01T00:00:00Z'), 10), bar(T('2024-02-01T00:01:00Z'), 11)], { complete: true });
    const got = await s.range(BTC, T('2024-01-31T23:59:00Z'), T('2024-02-01T00:01:00Z'));
    assert.deepEqual(got.map((b) => b.close), [3, 10], 'from is included, to is not');
    await s.writeMonth(BTC, '2017-01', [], { complete: true });
    assert.deepEqual((await s.index(BTC)).months['2017-01'], { n: 0, first: null, last: null, complete: true, bytes: 0 });
    assert.deepEqual(await s.range(BTC, T('2017-01-01T00:00:00Z'), T('2017-02-01T00:00:00Z')), []);
  });

  await ok('sizes add up; the limit drops the least recently used series first, never the kept one', async () => {
    const s = new HistoryStore(tmp);
    const many = (c) => Array.from({ length: 2000 }, (_, i) => bar(T('2024-03-01T00:00:00Z') + i * 60, c + Math.sin(i) * 50));
    const A = { provider: 'binance', symbol: 'AAA', interval: '1m' };
    const B = { provider: 'binance', symbol: 'BBB', interval: '1m' };
    await s.writeMonth(A, '2024-03', many(100));
    await s.writeMonth(B, '2024-03', many(200));
    (await s.index(A)).used = 1; await s.saveIndex(A, await s.index(A)); // A: used long ago
    (await s.index(B)).used = Date.now(); await s.saveIndex(B, await s.index(B));
    const total = await s.totalBytes();
    const list = await s.list();
    assert.equal(list.length, 3);
    assert.equal(total, list.reduce((x, y) => x + y.bytes, 0));
    s.capBytes = total - 1; // just over: one series has to go
    assert.equal(await s.enforceCap([BTC]), 1);
    assert.ok(!existsSync(s.seriesDir(A)), 'the oldest-used series went');
    assert.ok(existsSync(s.seriesDir(B)) && existsSync(s.seriesDir(BTC)));
    assert.deepEqual(await s.readMonth(A, '2024-03'), []);
  });

  await ok('one series or everything can be deleted', async () => {
    const s = new HistoryStore(tmp);
    await s.remove(BTC);
    assert.ok(!existsSync(s.seriesDir(BTC)));
    await s.removeAll();
    assert.equal(await s.totalBytes(), 0);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`history-store: ${n} checks passed`);
