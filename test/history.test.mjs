// Downloaded history: what downloads by itself, what asks first, background jobs, settings
// (lib/history.mjs), with a made-up source instead of the network. Run: node test/history.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History, AUTO_BYTES, monthBytes } from '../lib/history.mjs';
import { monthBounds } from '../lib/history-store.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`  ok ${name}`); };
const T = (s) => Date.parse(s) / 1000;
const NOW = T('2026-11-27T12:00:00Z');
const FIRST = T('2020-01-15T00:00:00Z');

/** A source with one bar an hour from FIRST on (called 1m so months count as big), recording the months asked. */
function fakeSource() {
  const asked = [];
  return {
    asked,
    first: async () => FIRST,
    month: async (ym) => {
      asked.push(ym);
      const { start, end } = monthBounds(ym);
      const bars = [];
      for (let t = Math.max(start, FIRST); t < Math.min(end, NOW); t += 3600) bars.push({ time: t, open: 1, high: 1, low: 1, close: t, volume: 1 });
      return { bars, complete: end <= NOW, bytes: 1000 };
    },
  };
}

const dirs = [];
function make(src = fakeSource()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-history-'));
  dirs.push(dir);
  return { h: new History({ dir, sources: { fake: src }, now: () => NOW }), src, dir };
}
const KEY = { provider: 'fake', symbol: 'XYZ', interval: '1m' };
const waitJob = async (h, job) => { for (let i = 0; i < 200 && (job.state === 'queued' || job.state === 'running'); i++) await new Promise((r) => setTimeout(r, 10)); };

try {
  await ok('scrolling back: the month it needs downloads by itself and the bars before the chart come back', async () => {
    const { h, src } = make();
    const before = T('2026-10-20T00:00:00Z');
    const r = await h.older(KEY, { before, count: 100 });
    assert.equal(r.ask, null);
    assert.equal(r.bars.length, 100);
    assert.ok(r.bars.every((b) => b.time < before) && r.bars.at(-1).time === before - 3600, 'the newest bar is right before the chart\'s first');
    assert.deepEqual(src.asked, ['2026-10']);
    await h.older(KEY, { before, count: 100 });
    assert.deepEqual(src.asked, ['2026-10'], 'a finished month is read from disk the second time');
  });

  await ok('a big jump (years back) asks first, with its size, and downloads nothing', async () => {
    const { h, src } = make();
    const r = await h.older(KEY, { before: T('2026-10-20T00:00:00Z'), from: T('2021-01-01T00:00:00Z') });
    assert.ok(r.ask && r.ask.months === 70 && r.ask.bytes === Math.round(70 * monthBytes(KEY)), JSON.stringify(r.ask));
    assert.ok(r.ask.bytes > AUTO_BYTES);
    assert.equal(r.ask.from, T('2021-01-01T00:00:00Z'));
    assert.deepEqual(src.asked, []);
    const forced = await h.older(KEY, { before: T('2021-03-01T00:00:00Z'), from: T('2021-01-01T00:00:00Z'), force: true });
    assert.equal(forced.ask, null);
    assert.equal(forced.bars[0].time, T('2021-01-01T00:00:00Z'));
  });

  await ok('with automatic downloads off, even a small one asks', async () => {
    const { h, src } = make();
    await h.updateSettings({ auto: false });
    const r = await h.older(KEY, { before: T('2026-10-20T00:00:00Z'), count: 100 });
    assert.equal(r.ask.months, 1);
    assert.deepEqual(r.bars, []);
    assert.deepEqual(src.asked, []);
  });

  await ok('history ends at the symbol\'s first bar', async () => {
    const { h } = make();
    const r = await h.older(KEY, { before: T('2020-02-10T00:00:00Z'), count: 100000 });
    assert.equal(r.done, true);
    assert.equal(r.bars[0].time, FIRST);
    const not = await h.older(KEY, { before: T('2023-02-10T00:00:00Z'), count: 10 });
    assert.equal(not.done, false);
  });

  await ok('a background download: progress, widened when asked again, cancelled', async () => {
    const { h, src } = make();
    const job = await h.download(KEY, { from: T('2026-06-01T00:00:00Z') });
    assert.equal(job.total, 6, 'June to November');
    const again = await h.download(KEY, { from: T('2026-04-01T00:00:00Z') });
    assert.equal(again, job, 'the same series widens the running job');
    assert.equal(job.total, 8);
    await waitJob(h, job);
    assert.equal(job.state, 'done');
    assert.equal(job.done, 8);
    assert.deepEqual([...src.asked].sort(), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    const st = await h.status();
    assert.equal(st.jobs.find((j) => j.id === job.id).state, 'done');
    assert.ok(st.totalBytes > 0);
    const big = await h.download(KEY, { from: T('2020-01-01T00:00:00Z') });
    assert.equal(h.cancel(big.id), true);
    await waitJob(h, big);
    assert.equal(big.state, 'cancelled');
    assert.ok(big.done < big.total);
  });

  await ok('asked again, only this month\'s newest bars are fetched: a quiet top-up, not shown as a download', async () => {
    const { h, src } = make();
    const first = await h.download(KEY, { from: T('2026-09-01T00:00:00Z') });
    await waitJob(h, first);
    assert.equal(first.topUp, false, 'the first time it is a real download');
    assert.equal(first.total, 3);
    const again = await h.download(KEY, { from: T('2026-09-01T00:00:00Z') });
    await waitJob(h, again);
    assert.equal(again.total, 1, 'only November, which isn\'t over');
    assert.equal(again.topUp, true);
    assert.equal(again.quiet, true);
    assert.equal((await h.status()).jobs.find((j) => j.id === again.id), undefined, 'done top-ups drop out of the list');
    assert.deepEqual(src.asked, ['2026-11', '2026-10', '2026-09', '2026-11']);
    // A range that also needs a month not here yet is a real download again.
    const wider = await h.download(KEY, { from: T('2026-08-01T00:00:00Z') });
    assert.equal(wider.topUp, false);
    await waitJob(h, wider);
    // Past months that are only partly here are real downloads too, not a top-up.
    await h.store.writeMonth(KEY, '2026-07', (await fakeSource().month('2026-07')).bars.slice(0, 100), { complete: false });
    const partial = await h.download(KEY, { from: T('2026-07-01T00:00:00Z') });
    assert.equal(partial.topUp, false, 'July (partly here) and November: shown');
    await waitJob(h, partial);
  });

  await ok('a top-up that a bigger download joins while it runs is shown as a download from then on', async () => {
    const slow = fakeSource();
    const real = slow.month;
    let release;
    const gate = new Promise((r) => { release = r; });
    slow.month = async (ym) => { await gate; return real(ym); };
    const { h } = make(slow);
    await h.store.writeMonth(KEY, '2026-11', (await real('2026-11')).bars.slice(0, 100), { complete: false }); // this month, partly here
    const top = await h.download(KEY, { from: T('2026-11-01T00:00:00Z'), quiet: true });
    assert.equal(top.topUp, true);
    const range = await h.download(KEY, { from: T('2026-05-01T00:00:00Z') }); // a range test, while the top-up runs
    assert.equal(range, top, 'it joins the running job');
    assert.equal(top.topUp, false, 'which is now a real download');
    assert.equal(top.quiet, false);
    assert.ok(top.total >= 7);
    release();
    await waitJob(h, top);
  });

  await ok('a download the user started carries on after a restart, fetching only what\'s missing', async () => {
    // First run: two months come in, then the app "closes" (the source stops answering).
    const stuck = fakeSource();
    let calls = 0;
    const realMonth = stuck.month;
    stuck.month = (ym) => (++calls <= 2 ? realMonth(ym) : new Promise(() => {}));
    const { h, dir } = make(stuck);
    const job = await h.download(KEY, { from: T('2026-06-01T00:00:00Z') });
    for (let i = 0; i < 100 && job.done < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await h.saveJobs();
    const saved = JSON.parse(readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].key, KEY);
    // Second run, same folder: the job is back, without the months already in.
    const src2 = fakeSource();
    const h2 = new History({ dir, sources: { fake: src2 }, now: () => NOW });
    await h2.ready;
    for (let i = 0; i < 200 && !(h2.jobs.size && [...h2.jobs.values()].every((j) => j.state === 'done')); i++) await new Promise((r) => setTimeout(r, 10));
    const j2 = [...h2.jobs.values()][0];
    assert.equal(j2?.state, 'done');
    // June to November is 6 months; November and October were in, but November is the current month:
    // never finished, so it updates again.
    assert.deepEqual(stuck.asked.slice(0, 2), ['2026-11', '2026-10']);
    assert.equal(j2.total, 5);
    assert.deepEqual([...src2.asked].sort(), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-11'], 'the finished October isn\'t fetched again');
    await h2.saveJobs();
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'jobs.json'), 'utf8')), [], 'finished: nothing left to resume');
    const c = await h2.download(KEY, { from: T('2020-01-01T00:00:00Z') });
    h2.cancel(c.id);
    await h2.saveJobs();
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'jobs.json'), 'utf8')), [], 'cancelled: not resumed either');
  });

  await ok('opening a chart prefetches its last months quietly', async () => {
    const { h, src } = make();
    const job = await h.prefetch(KEY);
    assert.equal(job.quiet, true);
    await waitJob(h, job);
    assert.deepEqual([...src.asked].sort(), ['2026-08', '2026-09', '2026-10', '2026-11']);
    assert.ok(!(await h.status()).jobs.some((j) => j.id === job.id), 'a finished quiet job isn\'t listed');
    await h.updateSettings({ auto: false });
    assert.equal(await h.prefetch(KEY), null, 'automatic downloads off: no prefetch');
  });

  await ok('a source that only keeps what the app saw: stored bars, then done', async () => {
    const { h, dir } = make();
    h.extra.seen = { first: async () => null, month: null };
    const K = { provider: 'seen', symbol: 'AAPL', interval: '5m' };
    await h.store.writeMonth(K, '2026-10', [{ time: T('2026-10-05T14:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const r = await h.older(K, { before: T('2026-11-03T00:00:00Z'), count: 50 });
    assert.equal(r.bars.length, 1);
    assert.equal(r.ask, null);
    const empty = await h.older(K, { before: T('2026-10-01T00:00:00Z'), count: 50 });
    assert.deepEqual(empty, { bars: [], done: true, ask: null });
    assert.ok(dir);
  });

  await ok('a replay far back gets a window from its date on: only those months download', async () => {
    const { h, src } = make();
    const K = { ...KEY, interval: '1h' }; // the made-up source has a bar an hour
    const from = T('2021-06-30T20:00:00Z');
    const w = await h.window(K, { from, count: 100 });
    assert.equal(w.ask, null);
    assert.equal(w.bars.length, 100);
    assert.equal(w.bars[0].time, from, 'it starts at the date');
    assert.ok(w.bars.every((b, i, a) => !i || b.time > a[i - 1].time), 'oldest first');
    assert.equal(w.more, true);
    assert.deepEqual(src.asked, ['2021-06', '2021-07'], 'the month of the date and the next (the window crosses into it), nothing since');
    const next = await h.window(K, { from: w.bars.at(-1).time + 3600, count: 100 });
    assert.equal(next.bars[0].time, w.bars.at(-1).time + 3600, 'the next window carries on');
    const before = await h.window(K, { from: T('2019-01-01T00:00:00Z'), count: 3 });
    assert.equal(before.bars[0].time, FIRST, 'before the first bar: from the first bar');
    const end = await h.window(K, { from: NOW - 3 * 3600, count: 100 });
    assert.equal(end.more, false, 'up to now: nothing more to come');
  });

  await ok('settings are saved; the Alpaca secret never comes back out', async () => {
    const { h, dir } = make();
    const pub = await h.updateSettings({ capGB: 5, alpaca: { keyId: 'PKABCDEFGH12', secret: 'topsecret' } });
    assert.deepEqual(pub, { auto: true, capGB: 5, alpaca: { keyId: 'PKAB…12' } });
    assert.ok(!JSON.stringify(await h.status()).includes('topsecret'));
    const again = new History({ dir, sources: {}, now: () => NOW });
    await again.ready;
    assert.equal(again.settings.alpaca.secret, 'topsecret', 'kept on this computer');
    assert.equal(again.store.capBytes, 5 * 1024 ** 3);
    assert.equal((await h.updateSettings({ alpaca: null })).alpaca, null);
    assert.ok(!readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('topsecret'), 'removed from disk too');
    assert.equal((await h.updateSettings({ capGB: 0 })).capGB, 5, 'a silly limit is ignored');
  });
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`history: ${n} checks passed`);
