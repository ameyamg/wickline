// Downloaded history, kept on this computer: bars from the archives and APIs that go further back
// than a chart's first load, so each month is downloaded once and then read from disk (offline too).
//
// A series is one provider's bars of one symbol at one interval: { provider: 'binance', symbol:
// 'BTCUSDT', interval: '1m' }. It lives in <dir>/<provider>/<symbol>/<interval>/ as one gzipped
// file per calendar month (UTC), YYYY-MM.json.gz, holding [[time, open, high, low, close, volume], …]
// with time in UTC seconds, plus index.json: { months: { 'YYYY-MM': { n, first, last, complete,
// bytes } }, used } (`complete`: the whole month is in, nothing more will come; `used`: last read,
// for the size limit). Unit-tested in test/history-store.test.mjs.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** 'YYYY-MM' of a UTC time in seconds. */
export const monthOf = (t) => new Date(t * 1000).toISOString().slice(0, 7);

/** The UTC start (seconds) of month 'YYYY-MM', and of the month after it. */
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, 1) / 1000, end: Date.UTC(y, m, 1) / 1000 };
}

/** The months from 'YYYY-MM' a to b, both included, oldest first. */
export function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * A file-system-safe name for a symbol or interval: letters, digits, '_' and '-' stay; anything else
 * becomes ~ and its code ("EURUSD=X" -> "EURUSD~3dX", "BRK.B" -> "BRK~2eB"), so there are no dots
 * (no "..") or separators, and different symbols never share a folder.
 */
export function safeName(s) {
  const out = String(s).replace(/[^A-Za-z0-9_-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  if (!out || out.length > 120) throw new Error(`Bad name: ${s}`);
  return out;
}

const keyId = (k) => `${k.provider}|${k.symbol}|${k.interval}`;

export class HistoryStore {
  /** dir: where everything goes; capBytes: the size limit (least recently used series go first). */
  constructor(dir, { capBytes = 2 * 1024 ** 3 } = {}) {
    this.dir = dir;
    this.capBytes = capBytes;
    this.indexes = new Map(); // keyId -> index (loaded on first use)
    this.locks = new Map(); // keyId -> promise chain, so writes to one series never interleave
  }

  seriesDir(key) {
    return path.join(this.dir, safeName(key.provider), safeName(key.symbol), safeName(key.interval));
  }

  /** Runs fn for this series after any earlier write to it has finished. */
  locked(key, fn) {
    const id = keyId(key);
    const run = (this.locks.get(id) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  async index(key) {
    const id = keyId(key);
    if (this.indexes.has(id)) return this.indexes.get(id);
    let idx;
    try { idx = JSON.parse(await fs.readFile(path.join(this.seriesDir(key), 'index.json'), 'utf8')); } catch { idx = null; }
    if (!idx || typeof idx.months !== 'object') idx = { months: {}, used: 0 };
    this.indexes.set(id, idx);
    return idx;
  }

  async saveIndex(key, idx) {
    const dir = this.seriesDir(key);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `index.json.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(idx));
    await fs.rename(tmp, path.join(dir, 'index.json'));
  }

  /** The month's bars ({ time, open, high, low, close, volume }, time order), or [] if not stored. */
  async readMonth(key, ym) {
    try {
      const rows = JSON.parse(await gunzip(await fs.readFile(path.join(this.seriesDir(key), `${ym}.json.gz`))));
      return rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
    } catch {
      return [];
    }
  }

  /**
   * Stores bars of one month (times outside it are ignored), merged with what's there: a bar of the
   * same time is replaced. complete: the month is finished and fully in (no need to fetch it again).
   */
  writeMonth(key, ym, bars, { complete = false } = {}) {
    return this.locked(key, async () => {
      const { start, end } = monthBounds(ym);
      const byTime = new Map((await this.readMonth(key, ym)).map((b) => [b.time, b]));
      for (const b of bars) if (b.time >= start && b.time < end && Number.isFinite(b.close)) byTime.set(b.time, b);
      const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
      const idx = await this.index(key);
      if (!merged.length) {
        if (complete) { idx.months[ym] = { n: 0, first: null, last: null, complete: true, bytes: 0 }; await this.saveIndex(key, idx); }
        return 0;
      }
      const dir = this.seriesDir(key);
      await fs.mkdir(dir, { recursive: true });
      const body = await gzip(JSON.stringify(merged.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume ?? 0])));
      const file = path.join(dir, `${ym}.json.gz`);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, file);
      const was = idx.months[ym];
      idx.months[ym] = { n: merged.length, first: merged[0].time, last: merged[merged.length - 1].time, complete: complete || !!was?.complete, bytes: body.length };
      await this.saveIndex(key, idx);
      this.totalCache = undefined;
      return merged.length;
    });
  }

  /** Bars with from <= time < to, read from the months that hold them; marks the series used. */
  async range(key, from, to) {
    const idx = await this.index(key);
    const want = monthsBetween(monthOf(from), monthOf(Math.max(from, to - 1))).filter((ym) => idx.months[ym]?.n);
    const out = [];
    for (const ym of want) for (const b of await this.readMonth(key, ym)) if (b.time >= from && b.time < to) out.push(b);
    if (want.length) this.touch(key, idx);
    return out;
  }

  /** Remembers the series was just used (saved now and then, not on every read). */
  touch(key, idx) {
    const now = Date.now();
    if (now - (idx.used || 0) < 60000) return;
    idx.used = now;
    this.locked(key, () => this.saveIndex(key, idx)).catch(() => {});
  }

  /** Every stored series: [{ provider, symbol, interval, bytes, used, months }] (names as stored). */
  async list() {
    const out = [];
    const dirs = async (p) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const prov of await dirs(this.dir)) {
      for (const sym of await dirs(path.join(this.dir, prov))) {
        for (const iv of await dirs(path.join(this.dir, prov, sym))) {
          let idx;
          try { idx = JSON.parse(await fs.readFile(path.join(this.dir, prov, sym, iv, 'index.json'), 'utf8')); } catch { continue; }
          const months = Object.keys(idx.months || {}).sort();
          const bytes = months.reduce((s, ym) => s + (idx.months[ym].bytes || 0), 0);
          out.push({ dir: [prov, sym, iv], bytes, used: idx.used || 0, months });
        }
      }
    }
    return out;
  }

  /** Bytes stored in all. */
  async totalBytes() {
    if (this.totalCache === undefined) this.totalCache = (await this.list()).reduce((s, x) => s + x.bytes, 0);
    return this.totalCache;
  }

  /** Deletes one series. */
  async remove(key) {
    await this.locked(key, () => fs.rm(this.seriesDir(key), { recursive: true, force: true }));
    this.indexes.delete(keyId(key));
    this.totalCache = undefined;
  }

  /** Deletes everything. */
  async removeAll() {
    await fs.rm(this.dir, { recursive: true, force: true });
    this.indexes.clear();
    this.totalCache = undefined;
  }

  /**
   * Keeps the total under the size limit: deletes whole series, least recently used first, except
   * `keep` (the series being shown or downloaded). Returns how many series went.
   */
  async enforceCap(keep = []) {
    const keepDirs = new Set(keep.map((k) => this.seriesDir(k)));
    const all = await this.list();
    let total = all.reduce((s, x) => s + x.bytes, 0);
    if (total <= this.capBytes) return 0;
    let removed = 0;
    for (const s of all.sort((a, b) => a.used - b.used)) {
      if (total <= this.capBytes) break;
      const dir = path.join(this.dir, ...s.dir);
      if (keepDirs.has(dir)) continue;
      await fs.rm(dir, { recursive: true, force: true });
      for (const [id] of this.indexes) if (path.join(this.dir, ...id.split('|').map(safeName)) === dir) this.indexes.delete(id);
      total -= s.bytes;
      removed++;
    }
    this.totalCache = undefined;
    return removed;
  }
}
