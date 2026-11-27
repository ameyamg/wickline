// Downloaded history: older bars than a chart's first load gives, from the store on disk
// (lib/history-store.mjs), downloading the months it doesn't have from their source
// (lib/history-sources.mjs, or a source the server adds, like Yahoo).
//
// How downloads behave:
//  - small ones (what scrolling back or a replay needs next) just happen;
//  - one that would be big (over AUTO_BYTES) is not started: the answer says how big, and the app
//    asks the user first;
//  - opening a chart quietly fetches its last PREFETCH_MONTHS months in the background;
//  - background downloads run two months at a time, with progress, and can be cancelled;
//  - the store stays under the size limit by dropping the least recently used symbols.
// Settings (dir/settings.json): { auto, capGB, alpaca: { keyId, secret } }. Unit-tested in test/history.test.mjs.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HistoryStore, monthOf, monthBounds, monthsBetween, safeName } from './history-store.mjs';
import { binanceMonth, binanceFirstBar, binanceRest, isBinanceProvider, alpacaBars, ALPACA_SINCE } from './history-sources.mjs';

export const AUTO_BYTES = 50e6;
export const PREFETCH_MONTHS = 3;
const GB = 1024 ** 3;

const intervalSec = (iv) => {
  const m = /^(\d+)([mhdw])/.exec(iv);
  return m ? +m[1] * { m: 60, h: 3600, d: 86400, w: 604800 }[m[2]] : 60;
};

/**
 * About how many bytes a month of a series downloads: a month of Binance 1-minute bars is a ~2.1 MB
 * zip (fewer bars, smaller files); Alpaca's minute bars of a US stock come as ~3 MB of JSON.
 */
export function monthBytes(key) {
  if (key.provider === 'alpaca') return 3e6;
  return Math.max(20e3, 2.1e6 * 60 / intervalSec(key.interval));
}

export const seriesLabel = (key) => `${key.symbol} ${key.interval.replace('+ext', '')}`;
const seriesId = (key) => `${key.provider}|${key.symbol}|${key.interval}`;

export class History {
  /**
   * dir: where history and its settings live. sources: extra month fetchers by provider,
   * e.g. { yahoo: { first: async (key) => sec | null, month: null } } (null: only what's stored).
   */
  constructor({ dir, fetchFn = fetch, sources = {}, now = () => Date.now() / 1000 }) {
    this.dir = dir;
    this.fetchFn = fetchFn;
    this.extra = sources;
    this.now = now;
    this.store = new HistoryStore(path.join(dir, 'bars'));
    this.settings = { auto: true, capGB: 2, alpaca: null };
    this.jobs = new Map(); // id -> job
    this.nextId = 1;
    this.active = 0;
    this.inflight = new Map(); // series|month -> promise, so a month is never fetched twice at once
    this.ready = this.loadSettings();
    this.ready.then(() => this.resumeJobs()).catch(() => {});
  }

  // --- settings -------------------------------------------------------------------------------

  async loadSettings() {
    try {
      const s = JSON.parse(await fs.readFile(path.join(this.dir, 'settings.json'), 'utf8'));
      this.settings = { ...this.settings, ...s };
    } catch { /* first run */ }
    this.store.capBytes = this.settings.capGB * GB;
  }

  /** Changes settings ({ auto, capGB, alpaca: { keyId, secret } | null }) and saves them. */
  async updateSettings(patch) {
    await this.ready;
    const next = { ...this.settings };
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    if (Number.isFinite(patch.capGB) && patch.capGB >= 0.25 && patch.capGB <= 200) next.capGB = patch.capGB;
    if ('alpaca' in patch) {
      const a = patch.alpaca;
      next.alpaca = a && String(a.keyId || '').trim() && String(a.secret || '').trim()
        ? { keyId: String(a.keyId).trim().slice(0, 100), secret: String(a.secret).trim().slice(0, 200) } : null;
    }
    this.settings = next;
    this.store.capBytes = next.capGB * GB;
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'settings.json');
    await fs.writeFile(`${file}.tmp`, JSON.stringify(next));
    await fs.rename(`${file}.tmp`, file);
    if (Number.isFinite(patch.capGB)) await this.store.enforceCap(this.busyKeys());
    return this.publicSettings();
  }

  /** What the page may see: never the Alpaca secret, and the key ID only partly. */
  publicSettings() {
    const a = this.settings.alpaca;
    return { auto: this.settings.auto, capGB: this.settings.capGB, alpaca: a ? { keyId: `${a.keyId.slice(0, 4)}…${a.keyId.slice(-2)}` } : null };
  }

  // --- where a series' months come from --------------------------------------------------------

  source(key) {
    if (isBinanceProvider(key.provider)) {
      return {
        first: () => binanceFirstBar(key.provider, key.symbol, key.interval, { fetchFn: this.fetchFn }),
        month: (ym, signal, since) => (since != null && monthBounds(ym).end > this.now()
          // The current month: only what's new since the last stored bar.
          ? binanceRest(key.provider, key.symbol, key.interval, since, Math.floor(this.now()), { fetchFn: this.fetchFn, signal })
            .then((bars) => ({ bars, complete: false, bytes: bars.length * 60 }))
          : binanceMonth(key.provider, key.symbol, key.interval, ym, { fetchFn: this.fetchFn, now: this.now(), signal })),
      };
    }
    if (key.provider === 'alpaca') {
      return {
        first: async () => ALPACA_SINCE,
        month: async (ym, signal, since) => {
          if (!this.settings.alpaca) throw Object.assign(new Error('No Alpaca key'), { code: 'alpaca-auth' });
          const { start, end } = monthBounds(ym);
          const now = this.now();
          const bars = await alpacaBars(key.symbol, since ?? start, end, this.settings.alpaca, { fetchFn: this.fetchFn, now, signal });
          return { bars, complete: end <= now - 16 * 60, bytes: bars.length * 60 };
        },
      };
    }
    const x = this.extra[key.provider];
    if (!x) throw Object.assign(new Error(`Unknown history source ${key.provider}`), { status: 400 });
    return x;
  }

  /** When the series' history starts (UTC seconds; asked once, then kept in its index), or null. */
  async firstBar(key) {
    const idx = await this.store.index(key);
    if (idx.first !== undefined && (idx.first !== null || this.now() - (idx.firstAsked || 0) < 86400)) return idx.first;
    let first = null;
    try { first = await this.source(key).first?.(key) ?? null; } catch { return null; }
    idx.first = first;
    idx.firstAsked = Math.floor(this.now());
    await this.store.locked(key, () => this.store.saveIndex(key, idx));
    return first;
  }

  /** Downloads a month into the store unless it's complete there. → bytes downloaded. */
  ensureMonth(key, ym, signal) {
    const id = `${key.provider}|${key.symbol}|${key.interval}|${ym}`;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const run = (async () => {
      const idx = await this.store.index(key);
      const have = idx.months[ym];
      if (have?.complete) return 0;
      const src = this.source(key);
      if (!src.month) return 0; // a source that only keeps what the app saw (Yahoo)
      const since = have?.last != null ? have.last + intervalSec(key.interval) : null;
      const got = await src.month(ym, signal, since);
      await this.store.writeMonth(key, ym, got.bars, { complete: got.complete });
      return got.bytes || 0;
    })().finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }

  /**
   * The months to read for bars before `before` (UTC seconds): back from its month, until about
   * `count` bars (by the stored counts, else what a full month holds) or `from`, never before the
   * series' first bar. → { months (newest first), firstMonth }.
   */
  async plan(key, { before, count = 2000, from = null }) {
    const first = await this.firstBar(key);
    const idx = await this.store.index(key);
    const lastMonth = monthOf(before - 1);
    const floor = [first != null ? monthOf(first) : null, from != null ? monthOf(from) : null].filter(Boolean).sort().pop() ?? null;
    const perMonth = Math.round(30 * 86400 / intervalSec(key.interval));
    const months = [];
    let n = 0;
    if (!this.source(key).month) {
      // Only what the app saved (Yahoo): the stored months before `before`, skipping gaps.
      for (const ym of Object.keys(idx.months).filter((m) => m <= lastMonth && idx.months[m].n && (!floor || m >= floor)).sort().reverse()) {
        months.push(ym);
        n += idx.months[ym].n;
        if (from == null && n >= count) break;
      }
      return { months, firstMonth: null };
    }
    let ym = lastMonth;
    for (let k = 0; k < 600; k++) {
      if (floor && ym < floor) break;
      months.push(ym);
      const full = idx.months[ym]?.complete ? idx.months[ym].n : perMonth;
      // The month holding `before` only counts up to it.
      n += k ? full : Math.min(full, Math.ceil((before - monthBounds(ym).start) / intervalSec(key.interval)));
      if (from == null && n >= count) break;
      const [y, m] = ym.split('-').map(Number);
      ym = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    }
    return { months, firstMonth: first != null ? monthOf(first) : null };
  }

  /**
   * Bars before `before` (UTC seconds, oldest first): about `count` of them, or back to `from`.
   * Missing months are downloaded first when that's small (and automatic downloads are on, or
   * force); otherwise the answer has `ask: { from, bytes, months }` and only what's stored.
   * done: there's nothing older than these.
   */
  async older(key, { before, count = 2000, from = null, force = false } = {}) {
    await this.ready;
    const { months, firstMonth } = await this.plan(key, { before, count, from });
    const idx = await this.store.index(key);
    const src = this.source(key);
    const missing = src.month ? months.filter((ym) => !idx.months[ym]?.complete) : [];
    const bytes = missing.reduce((s, ym) => s + (idx.months[ym]?.n ? monthBytes(key) / 2 : monthBytes(key)), 0);
    let ask = null;
    if (missing.length && (force || (this.settings.auto && bytes <= AUTO_BYTES))) {
      await this.mapLimit(missing, 2, (ym) => this.ensureMonth(key, ym));
      await this.store.enforceCap([key, ...this.busyKeys()]);
    } else if (missing.length) {
      ask = { from: monthBounds(missing[missing.length - 1]).start, bytes: Math.round(bytes), months: missing.length };
    }
    const oldest = months.length ? monthBounds(months[months.length - 1]).start : before;
    let bars = await this.store.range(key, from != null ? Math.max(from, oldest) : oldest, before);
    if (from == null && bars.length > count) bars = bars.slice(bars.length - count);
    const reachedStart = firstMonth != null && months[months.length - 1] === firstMonth && !ask;
    const ranOut = !src.month && !bars.length;
    return { bars, done: reachedStart || ranOut, ask };
  }

  /**
   * Bars from `from` (UTC seconds) on, oldest first, about `count` of them: a replay that starts far
   * back plays from these and asks for the next ones as it goes, so only the months around it are
   * needed (a few MB), not everything since. → { bars, more, ask } (more: newer bars follow).
   */
  async window(key, { from, count = 5000, force = false } = {}) {
    await this.ready;
    const src = this.source(key);
    const first = src.month ? await this.firstBar(key) : null;
    const start = Math.max(from, first ?? from);
    const idx = await this.store.index(key);
    const step = intervalSec(key.interval);
    const nowMonth = monthOf(this.now());
    const months = [];
    let n = 0;
    if (!src.month) { // only what the app saved: the stored months from there on
      for (const ym of Object.keys(idx.months).filter((m) => m >= monthOf(start) && idx.months[m].n).sort()) {
        months.push(ym);
        n += idx.months[ym].n;
        if (n >= count) break;
      }
    } else {
      for (let ym = monthOf(start); ym <= nowMonth && months.length < 600;) {
        months.push(ym);
        const { end } = monthBounds(ym);
        const full = idx.months[ym]?.complete ? idx.months[ym].n : Math.round(30 * 86400 / step);
        n += months.length > 1 ? full : Math.min(full, Math.ceil((end - start) / step));
        if (n >= count) break;
        const [y, m] = ym.split('-').map(Number);
        ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      }
    }
    const missing = src.month ? months.filter((ym) => !idx.months[ym]?.complete) : [];
    const bytes = missing.reduce((s, ym) => s + (idx.months[ym]?.n ? monthBytes(key) / 2 : monthBytes(key)), 0);
    if (missing.length && !(force || (this.settings.auto && bytes <= AUTO_BYTES))) {
      return { bars: [], more: true, ask: { from: monthBounds(missing[0]).start, bytes: Math.round(bytes), months: missing.length } };
    }
    if (missing.length) {
      await this.mapLimit(missing, 2, (ym) => this.ensureMonth(key, ym));
      await this.store.enforceCap([key, ...this.busyKeys()]);
    }
    const last = months[months.length - 1];
    const bars = last ? (await this.store.range(key, start, monthBounds(last).end)).slice(0, count) : [];
    const more = bars.length >= count || (last != null && last < nowMonth && (!!src.month || Object.keys(idx.months).some((m) => m > last && idx.months[m].n)));
    return { bars, more, ask: null };
  }

  async mapLimit(items, limit, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  }

  // --- background downloads --------------------------------------------------------------------

  busyKeys() {
    return [...this.jobs.values()].filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.key);
  }

  /**
   * Downloads a series' months from `from` to `to` (UTC seconds; to: now) in the background.
   * quiet: a prefetch, not shown as asked by the user. → the job.
   */
  async download(key, { from, to = this.now(), quiet = false } = {}) {
    await this.ready;
    const first = await this.firstBar(key);
    const start = Math.max(from ?? 0, first ?? from ?? 0);
    const idx = await this.store.index(key);
    const months = monthsBetween(monthOf(start), monthOf(to - 1)).filter((ym) => !idx.months[ym]?.complete).reverse(); // newest first
    // Only months already partly here (this month: its bars since the last time): a quick top-up, done
    // quietly, not shown as a download.
    const topUp = months.length > 0 && months.every((ym) => idx.months[ym]);
    if (topUp) quiet = true;
    const same = [...this.jobs.values()].find((j) => (j.state === 'queued' || j.state === 'running') && seriesId(j.key) === seriesId(key));
    if (same) { // already downloading this series: widen that job instead of starting another
      for (const ym of months) if (!same.months.includes(ym)) same.months.push(ym);
      same.total = same.months.length;
      same.from = Math.min(same.from, start);
      same.to = Math.max(same.to, to);
      if (!quiet) same.quiet = false;
      if (!same.quiet) this.saveJobs();
      return same;
    }
    const job = { id: this.nextId++, key, label: seriesLabel(key), months, total: months.length, done: 0, bytes: 0, state: 'queued', quiet, topUp, error: null, from: start, to, controller: new AbortController() };
    this.jobs.set(job.id, job);
    if (!months.length) job.state = 'done';
    if (!quiet) this.saveJobs();
    this.pump();
    return job;
  }

  /**
   * The last few months of a series, quietly (opening a chart). For crypto, not the current month:
   * the chart pages that from the exchange's API anyway, and it's never finished.
   */
  async prefetch(key) {
    await this.ready;
    if (!this.settings.auto) return null; // automatic downloads off: only what the user asks for
    const now = this.now();
    const ym = monthsBetween(monthOf(now - PREFETCH_MONTHS * 31 * 86400), monthOf(now))[0];
    const to = isBinanceProvider(key.provider) ? monthBounds(monthOf(now)).start : now;
    return this.download(key, { from: monthBounds(ym).start, to, quiet: true });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.state === 'done' || job.state === 'error') return false;
    job.state = 'cancelled';
    job.controller.abort();
    this.saveJobs();
    return true;
  }

  /**
   * The downloads the user started and that haven't finished, in dir/jobs.json, so they carry on after
   * a restart (resumeJobs). Prefetches aren't kept: opening the chart again starts them.
   */
  saveJobs() {
    const open = [...this.jobs.values()].filter((j) => !j.quiet && (j.state === 'queued' || j.state === 'running')).map((j) => ({ key: j.key, from: j.from, to: j.to }));
    this.savingJobs = (this.savingJobs || Promise.resolve()).then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, 'jobs.json');
      await fs.writeFile(`${file}.tmp`, JSON.stringify(open));
      await fs.rename(`${file}.tmp`, file);
    }).catch(() => {});
    return this.savingJobs;
  }

  /** Starts again the downloads that were running when the app closed (only their missing months fetch). */
  async resumeJobs() {
    let list;
    try { list = JSON.parse(await fs.readFile(path.join(this.dir, 'jobs.json'), 'utf8')); } catch { return; }
    for (const j of Array.isArray(list) ? list : []) {
      const k = j?.key;
      if (!k || typeof k.provider !== 'string' || typeof k.symbol !== 'string' || typeof k.interval !== 'string' || !Number.isFinite(j.from)) continue;
      try { await this.download({ provider: k.provider, symbol: k.symbol, interval: k.interval }, { from: j.from, to: Math.min(Number(j.to) || this.now(), this.now()) }); } catch { /* a source that's gone */ }
    }
  }

  pump() {
    // One month of one job at a time per slot, two slots: a big download never blocks a small one for long.
    while (this.active < 2) {
      const job = [...this.jobs.values()].find((j) => (j.state === 'queued' || j.state === 'running') && j.done + (j.taking || 0) < j.months.length);
      if (!job) break;
      const ym = job.months[job.done + (job.taking || 0)];
      job.taking = (job.taking || 0) + 1;
      job.state = 'running';
      this.active++;
      this.ensureMonth(job.key, ym, job.controller.signal)
        .then((b) => { job.bytes += b; job.done++; })
        .catch((e) => {
          if (job.state === 'cancelled') return;
          job.done++;
          if (e.code === 'alpaca-auth' || e.status === 400) { job.state = 'error'; job.error = e.code || e.message; }
          else job.failed = (job.failed || 0) + 1;
        })
        .finally(async () => {
          job.taking--;
          this.active--;
          if (job.state === 'running' && job.done >= job.months.length) {
            job.state = job.failed && job.failed === job.total ? 'error' : 'done';
            job.finished = Date.now();
            if (!job.quiet) this.saveJobs();
            await this.store.enforceCap([job.key, ...this.busyKeys()]).catch(() => {});
          }
          this.pump();
        });
    }
    // Forget finished jobs after a while.
    for (const [id, j] of this.jobs) if (j.finished && Date.now() - j.finished > 10 * 60000) this.jobs.delete(id);
  }

  async status() {
    await this.ready;
    return {
      ...this.publicSettings(),
      totalBytes: await this.store.totalBytes(),
      jobs: [...this.jobs.values()].filter((j) => !(j.quiet && j.state === 'done')).map((j) => ({
        id: j.id, provider: j.key.provider, label: j.label, done: j.done, total: j.total, bytes: j.bytes, state: j.state, quiet: j.quiet, topUp: !!j.topUp, error: j.error,
      })),
    };
  }

  /** Deletes one symbol's downloaded history (every interval and provider), or all of it. */
  async remove(symbol = null) {
    if (!symbol) { for (const j of this.jobs.values()) this.cancel(j.id); await this.store.removeAll(); return; }
    for (const s of await this.store.list()) {
      if (s.dir[1] !== safeName(symbol)) continue;
      await fs.rm(path.join(this.store.dir, ...s.dir), { recursive: true, force: true });
    }
    this.store.indexes.clear();
    this.store.totalCache = undefined;
  }
}
