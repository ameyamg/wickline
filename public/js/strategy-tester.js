// The Strategy Tester panel: results of the strategy scripts on the active chart, on the chart's own
// bars (updated live) or over a date range (From / To), whose history loads, and downloads first, for it.

import * as LWC from '../vendor/lightweight-charts.mjs';
import { THEMES, currentThemeName } from './chart-view.js';
import { STRATEGY_DEFAULTS } from './backtest.js';
import { $, esc, store, fixed } from './util.js';
import { tradesCsv } from './csv.js';
import { t, lang, locale } from './i18n.js';
import { loadRangeBars, RangeCancelled, rangeTimeout } from './range-test.js';
import { formatBytes } from './history.js';

/** Most points drawn per line on the Overview chart (a range test can have a million bars): enough
 *  for any screen's width, and few enough to all fit in the chart. */
const CHART_POINTS = 4000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Exit reasons backtest.js writes (English, it runs in a worker) → the UI language. A script's own
// comment is shown as written.
const REASONS = {
  Close: t('st.reason.close'), Reverse: t('st.reason.reverse'), 'Stop loss': t('st.reason.stopLoss'), Stop: t('st.reason.stop'),
  'Trailing stop': t('st.reason.trailing'), 'Take profit': t('st.reason.takeProfit'),
};
const reasonText = (r) => (Object.hasOwn(REASONS, r) ? REASONS[r] : r);

const money = (v, sign = false) => {
  if (v == null || !Number.isFinite(v)) return v === Infinity ? '∞' : '—';
  const s = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${s}`;
};
const pct = (v, sign = true) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${fixed(Math.abs(v), 2)}%`);
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? (v === Infinity ? '∞' : '—') : fixed(v, d));
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function fmtTime(ts, daily) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return daily ? date : `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export class StrategyTester {
  constructor({ getView, toast, browseStrategies, alpacaKey }) {
    this.getView = getView;
    this.toast = toast;
    this.browseStrategies = browseStrategies;
    this.alpacaKey = alpacaKey; // opens Settings at the Alpaca key
    this.el = $('#tester');
    this.select = $('#st-select');
    this.content = $('#st-content');
    this.tab = 'overview';
    this.view = null;
    this.chart = null;
    this.seen = new Set(); // strategies that already opened the panel once

    this.el.querySelector('.st-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st-tab]');
      if (!b) return;
      this.tab = b.dataset.stTab;
      this.tableSig = null;
      this.render();
    });
    // Picking a strategy makes it the one on the chart (the chart shows one; the others wait in this list).
    this.select.addEventListener('change', () => { this.view?.setActiveStrategy(this.select.value); this.render(); });
    this.buildRangeBar();
    $('#st-close').addEventListener('click', () => this.close());
    $('#st-add').addEventListener('click', () => this.browseStrategies?.());
    this.content.addEventListener('click', (e) => this.onClick(e));
    this.content.addEventListener('submit', (e) => { e.preventDefault(); this.applyProps(); });
    this.content.addEventListener('keydown', (e) => e.stopPropagation());

    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('testerHeight', 340), false);
  }

  get isOpen() { return !this.el.hidden; }

  // --- Date range ------------------------------------------------------------------
  /**
   * "Chart bars" (the strategy as it runs on the chart, live) or "Date range": From / To and Run. A
   * range test is a snapshot: its bars load (and download first) for it, then the strategy runs over
   * them in a worker of its own, with the chart's inputs and properties.
   */
  buildRangeBar() {
    const saved = store.get('testerDates', null);
    const today = isoDay(Date.now());
    const day = (v, fallback) => (typeof v === 'string' && DATE_RE.test(v) ? v : fallback);
    // results / errors: each strategy's last range test (by its id), so switching between them shows
    // theirs straight away. used: Run was pressed, so a strategy or chart without a test gets one by itself.
    this.range = { mode: store.get('testerRange', 'chart') === 'range' ? 'range' : 'chart', run: null, results: new Map(), errors: new Map(), used: false, cache: null };
    const box = document.createElement('span');
    box.className = 'st-range';
    box.innerHTML = `<select class="select st-range-mode" aria-label="${esc(t('st.range.label'))}" title="${esc(t('st.range.label'))}">
        <option value="chart">${esc(t('st.range.chart'))}</option><option value="range">${esc(t('st.range.dates'))}</option></select>
      <span class="st-range-dates">
        <input type="date" class="rp-date st-from" aria-label="${esc(t('st.range.from'))}" title="${esc(t('st.range.from'))}" max="${today}" value="${day(saved?.from, isoDay(Date.now() - 365 * 86400e3))}">
        <span class="muted">–</span>
        <input type="date" class="rp-date st-to" aria-label="${esc(t('st.range.to'))}" title="${esc(t('st.range.to'))}" max="${today}" value="${day(saved?.to, today)}">
        <button type="button" class="tb-btn st-run">${esc(t('st.range.run'))}</button>
      </span>`;
    this.el.querySelector('.st-tabs').before(box);
    this.modeSel = box.querySelector('.st-range-mode');
    this.fromInput = box.querySelector('.st-from');
    this.toInput = box.querySelector('.st-to');
    this.datesEl = box.querySelector('.st-range-dates');
    this.modeSel.value = this.range.mode;
    this.datesEl.hidden = this.range.mode !== 'range';
    this.modeSel.addEventListener('change', () => {
      this.range.mode = this.modeSel.value === 'range' ? 'range' : 'chart';
      store.set('testerRange', this.range.mode);
      this.datesEl.hidden = this.range.mode !== 'range';
      this.tableSig = null;
      this.render();
    });
    box.querySelector('.st-run').addEventListener('click', () => this.runRange({ pressed: true }));
    for (const input of [this.fromInput, this.toInput]) {
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.runRange({ pressed: true }); });
    }
  }

  /** What a range result belongs to: the chart's symbol and timeframe. */
  viewKey() { return this.view ? `${this.view.state.symbol}|${this.view.tf.id}` : ''; }

  /**
   * The chart shows what the tester shows: the date-range test's trades and numbers for `entry` (the
   * strategy on the chart) while the tester shows that test, its own result otherwise (and once closed).
   */
  syncChart(entry = null, result = null) {
    for (const view of new Set([this.view, this.chartShowing].filter(Boolean))) {
      for (const e of view.strategies?.() || []) view.showStrategyRange?.(e.inst.id, view === this.view && e === entry ? result : null);
    }
    this.chartShowing = result ? this.view : null;
  }

  /** This strategy's range test (or failed one) of the chart as it is now (symbol and timeframe), if any. */
  rangeOf(map, entry) {
    const x = map.get(entry.inst.id);
    return x && x.viewKey === this.viewKey() ? x : null;
  }

  /**
   * Runs the strategy shown over From..To (days in chart time, the same as the chart's axis). pressed:
   * the user pressed Run (maybe with new dates): the other strategies' tests are dropped, so picking one
   * tests it on these dates too.
   */
  async runRange({ pressed = false } = {}) {
    const { entry } = this.current();
    const view = this.view;
    if (!entry || !view) { this.toast(t('st.noStrategy')); return; }
    const from = Date.parse(`${this.fromInput.value}T00:00:00Z`) / 1000;
    const to = Date.parse(`${this.toInput.value}T00:00:00Z`) / 1000 + 86399;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) { this.toast(t('st.range.badDates')); return; }
    store.set('testerDates', { from: this.fromInput.value, to: this.toInput.value });
    if (this.range.mode !== 'range') { this.modeSel.value = 'range'; this.modeSel.dispatchEvent(new Event('change')); }
    this.range.run?.handle.cancel?.();
    const viewKey = this.viewKey();
    const key = `${viewKey}|${from}|${to}`;
    const run = { entryId: entry.inst.id, viewKey, step: 'start', handle: {} };
    this.range.run = run;
    this.range.used = true;
    if (pressed) { this.range.results.clear(); this.range.errors.clear(); }
    this.range.errors.delete(entry.inst.id);
    this.tableSig = null;
    this.render();
    const progress = (s) => {
      Object.assign(run, s);
      if (this.range.run === run && this.isOpen && this.range.mode === 'range') this.renderProgress(run);
    };
    try {
      let bars = this.range.cache?.key === key ? this.range.cache.bars : null;
      if (!bars) {
        bars = await loadRangeBars(view.state.symbol, view.tf, from, to, { onStep: progress, run: run.handle });
        if (this.range.run !== run) return;
        this.range.cache = { key, bars };
      }
      if (bars.length < 2) throw new Error(t('st.range.noBars'));
      progress({ step: 'test', bars: bars.length });
      const res = await view.backtestBars(entry.inst.id, bars, { timeoutMs: rangeTimeout(bars.length) });
      if (this.range.run !== run) return;
      if (!res.strategy) throw new Error(t('st.range.notStrategy'));
      this.range.results.set(entry.inst.id, {
        entryId: entry.inst.id, viewKey, from, to, start: bars[0].time, end: bars[bars.length - 1].time,
        report: res.strategy, times: bars.map((b) => b.time), alpacaHint: !!run.handle.alpacaHint,
      });
    } catch (e) {
      if (e instanceof RangeCancelled || this.range.run !== run) return;
      this.range.errors.set(entry.inst.id, { entryId: entry.inst.id, viewKey, message: e.message, alpacaHint: !!run.handle.alpacaHint });
      this.range.results.delete(entry.inst.id);
    } finally {
      if (this.range.run === run) { this.range.run = null; this.render(); }
    }
  }

  /** The Alpaca key changed: stock bars loaded for a range may now reach further, so ranges are tested again. */
  resetRanges() {
    this.range.cache = null;
    this.range.results.clear();
    this.range.errors.clear();
    this.render();
  }

  cancelRange() {
    const run = this.range.run;
    if (!run) return;
    run.handle.cancel?.(); // a test already running finishes in its worker; its result is dropped
    this.range.run = null;
    this.render();
  }

  renderProgress(run) {
    const n = (v) => Number(v || 0).toLocaleString(locale);
    let text = t('st.range.preparing');
    let share = null; // null: a bar that moves without a known end
    if (run.step === 'download') {
      text = t('st.range.downloading', { symbol: this.view?.ticker || '', done: n(run.done), total: n(run.total), size: formatBytes(run.bytes || 0, locale) });
      share = run.total ? run.done / run.total : 0;
    } else if (run.step === 'load') text = t('st.range.loading', { n: n(run.bars) });
    else if (run.step === 'test') text = t('st.range.testing', { n: n(run.bars) });
    let box = this.content.querySelector('.st-progress');
    if (!box) {
      this.destroyChart();
      this.content.innerHTML = `<div class="st-empty st-progress" role="status"><b class="st-progress-text"></b>
        <div class="st-bar"><i></i></div><button type="button" class="btn-ghost" data-st="cancel">${esc(t('common.cancel'))}</button></div>`;
      box = this.content.querySelector('.st-progress');
    }
    box.querySelector('.st-progress-text').textContent = text;
    const bar = box.querySelector('.st-bar');
    bar.classList.toggle('busy', share == null);
    bar.querySelector('i').style.width = share == null ? '' : `${Math.round(share * 100)}%`;
  }

  rangeEmptyHtml(entry) {
    const e = this.rangeOf(this.range.errors, entry);
    const failed = !!e;
    const hint = failed && e.alpacaHint ? `<span>${esc(t('st.range.alpacaHint'))}</span><button type="button" class="btn-primary st-browse" data-st="alpaca">${esc(t('hist.alpacaAdd'))}</button>` : '';
    return `<div class="st-empty"><b>${esc(failed ? t('st.range.failed') : t('st.range.title'))}</b>
      ${failed ? `<span>${esc(e.message)}</span>` : ''}${hint}
      <span>${esc(t('st.range.howTo', { name: entry.def?.name || '', symbol: this.view?.ticker || '' }))}</span></div>`;
  }

  open() {
    this.el.hidden = false;
    document.body.classList.add('tester-open');
    this.render();
    window.dispatchEvent(new Event('resize'));
  }

  close() {
    this.syncChart(); // closed: the chart shows the strategies' own results
    this.el.hidden = true;
    document.body.classList.remove('tester-open');
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(200, Math.min(window.innerHeight * 0.8, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('testerHeight', height);
  }

  setView(view) {
    this.view = view;
    if (this.isOpen) this.render();
  }

  /** Called whenever a strategy on any chart finishes a backtest. */
  onResult(view, entry) {
    if (!this.seen.has(entry.inst.id)) {
      this.seen.add(entry.inst.id);
      if (view === this.getView()) {
        this.view = view;
        if (!this.isOpen) this.open();
        else if (entry === view.activeStrategy()) { this.render(); return; } // a strategy just added: the tester switches to it
      }
    }
    if (view !== this.view || !this.isOpen) return;
    if (entry === view.activeStrategy()) this.render(true);
  }

  /** The chart's strategies, and the one it shows (the tester shows the same one). */
  current() {
    const strategies = this.view?.strategies() || [];
    return { strategies, entry: this.view?.activeStrategy?.() || null };
  }

  render(live = false) {
    if (!this.isOpen) return;
    const { strategies, entry } = this.current();
    this.select.innerHTML = strategies.map((e) => `<option value="${esc(e.inst.id)}">${esc(e.def.name)}</option>`).join('')
      || `<option>${esc(t('st.noStrategyOption'))}</option>`;
    this.select.value = entry?.inst.id || '';
    this.select.disabled = !entry;
    this.el.querySelectorAll('[data-st-tab]').forEach((b) => b.classList.toggle('on', b.dataset.stTab === this.tab));
    $('#st-symbol').textContent = this.view ? `${this.view.ticker} · ${this.view.tf.label}` : '';

    // What to show: the strategy's result on the chart's bars, or its date-range test (a snapshot,
    // so the chart's live updates leave it alone). The chart shows the same (syncChart).
    let src = entry;
    if (entry && this.range.mode === 'range') {
      if (live) return;
      const { run } = this.range;
      const running = run && run.entryId === entry.inst.id && run.viewKey === this.viewKey();
      const ours = this.rangeOf(this.range.results, entry);
      // Once Run has been used: a strategy picked (or just added), or the chart on another symbol or
      // timeframe, without a test there yet gets one, for the same dates (downloading what it needs first).
      if (this.range.used && !running && !ours && !this.rangeOf(this.range.errors, entry)) { this.runRange(); return; }
      this.syncChart(entry, ours);
      if (running) { this.shown = null; this.renderProgress(run); return; }
      if (!ours) {
        this.destroyChart();
        this.shown = null;
        this.content.innerHTML = this.rangeEmptyHtml(entry);
        return;
      }
      src = { inst: entry.inst, def: entry.def, report: ours.report, times: ours.times, range: ours };
    } else this.syncChart();
    this.shown = src?.report ? src : null;
    if (!src || !src.report) {
      this.destroyChart();
      this.content.innerHTML = this.emptyHtml(entry);
      return;
    }
    // Live updates only refresh what's visible, and keep the properties form untouched while editing.
    if (live && this.tab === 'properties') return;
    const r = src.report;
    if (this.tab === 'overview') { this.renderOverview(src, r, live); return; }
    this.destroyChart();
    if (this.tab === 'properties') { this.renderProps(src, r); return; }
    // Tables: on live ticks, redraw only when the trades changed, and keep scroll and selection.
    const last = r.trades[r.trades.length - 1];
    const sig = `${this.tab}|${entry.inst.id}|${src.range ? `range:${src.range.from}-${src.range.to}` : 'chart'}|${r.trades.length}|${r.openTrades.length}|${last?.exitIndex}|${Math.round(r.summary.openPnl)}`;
    if (live && sig === this.tableSig) return;
    this.tableSig = sig;
    const wrap = this.content.querySelector('.st-table-wrap');
    const scroll = live && wrap ? wrap.scrollTop : 0;
    const selected = live ? this.content.querySelector('tr.sel')?.dataset.ei : null;
    if (this.tab === 'performance') this.renderPerformance(r);
    else this.renderTrades(src, r);
    const next = this.content.querySelector('.st-table-wrap');
    if (next) next.scrollTop = scroll;
    if (selected != null) this.content.querySelector(`tr[data-ei="${selected}"]`)?.classList.add('sel');
  }

  // --- Overview ---------------------------------------------------------------
  renderOverview(entry, r, live) {
    const s = r.summary;
    const kpi = (label, value, sub = '', c = '') => `<div class="st-kpi"><span>${esc(label)}</span><b class="${c}">${value}</b><small>${esc(sub)}</small></div>`;
    const kpis = `<div class="st-kpis">
      ${kpi(t('st.netProfit'), money(s.netProfit, true), pct(s.netProfitPct), cls(s.netProfit))}
      ${kpi(t('st.closedTrades'), s.trades, t('st.wonLost', { wins: s.wins, losses: s.losses }))}
      ${kpi(t('st.winRate'), pct(s.winRate, false), '')}
      ${kpi(t('st.profitFactor'), num(s.profitFactor, 3), '')}
      ${kpi(t('st.maxDrawdown'), money(-s.maxDrawdown), pct(-s.maxDrawdownPct), 'down')}
      ${kpi(t('st.avgTrade'), money(s.avgTrade, true), pct(s.avgTradePct), cls(s.avgTrade))}
      ${kpi(t('st.buyHold'), pct(s.buyHoldPct), t('st.samePeriod'), cls(s.buyHoldPct))}
      ${kpi(t('st.openPnl'), money(s.openPnl, true), r.openTrades.length ? t('st.nOpen', { n: r.openTrades.length }) : t('st.flat'), cls(s.openPnl))}
    </div>`;
    if (!live || !this.content.querySelector('.st-kpis')) {
      this.destroyChart();
      // A range test says what it covered, and when the data started later than asked.
      const rg = entry.range;
      const daily = this.view?.tf.daily;
      const late = rg && rg.start > rg.from + 5 * 86400; // the data starts later than asked
      const alpaca = late && rg.alpacaHint ? ` <button type="button" class="st-link" data-st="alpaca" title="${esc(t('st.range.alpacaHint'))}">${esc(t('hist.alpacaAdd'))}</button>` : '';
      const span = rg ? `${esc(t('st.range.span', { from: fmtTime(rg.start, true), to: fmtTime(rg.end, true) }))}${late ? ` (${esc(t('st.range.dataFrom', { date: fmtTime(rg.start, daily) }))})${alpaca}` : ''} · ` : '';
      this.content.innerHTML = `${kpis}<div class="st-chart-wrap"><div class="st-legend">
        <span><i style="background:#4FA3F7"></i>${esc(t('st.equity'))}</span><span><i style="background:#8E8A82"></i>${esc(t('st.buyHold'))}</span><span><i style="background:#EC5246"></i>${esc(t('st.drawdown'))}</span>
        <span class="muted">${span}${esc(t('st.bars', { n: r.equity.length.toLocaleString(locale) }))} · ${esc(this.describeProps(r.props))}</span></div><div class="st-chart"></div></div>`;
      this.createChart();
    } else {
      this.content.querySelector('.st-kpis').outerHTML = kpis;
    }
    const times = entry.times;
    // Over many bars, every step-th point (and the last): the line looks the same and stays quick.
    const step = Math.max(1, Math.ceil(times.length / CHART_POINTS));
    const mk = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i += step) if (times[i] != null) out.push({ time: times[i], value: arr[i] });
      const z = arr.length - 1;
      if (step > 1 && z >= 0 && z % step && times[z] != null) out.push({ time: times[z], value: arr[z] });
      return out;
    };
    this.eqSeries.setData(mk(r.equity));
    this.bhSeries.setData(mk(r.buyHold));
    this.ddSeries.setData(mk(r.drawdown));
    if (!live) this.chart.timeScale().fitContent();
  }

  createChart() {
    const th = THEMES[currentThemeName()];
    const host = this.content.querySelector('.st-chart');
    this.chart = LWC.createChart(host, {
      autoSize: true,
      layout: { background: { type: LWC.ColorType.Solid, color: th.bg }, textColor: th.text, fontSize: 11, panes: { separatorColor: th.separator } },
      localization: { locale, ...(lang === 'en' ? {} : { dateFormat: 'yyyy-MM-dd' }) }, // as the main chart
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      rightPriceScale: { borderColor: th.border },
      // minBarSpacing: the whole test fits the width (the library's default, 0.5 px a point, can't show 4,000)
      timeScale: { borderColor: th.border, timeVisible: !this.view?.tf.daily, minBarSpacing: 0.05 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
    });
    const fmt = { type: 'price', precision: 2, minMove: 0.01 };
    this.eqSeries = this.chart.addSeries(LWC.AreaSeries, {
      lineColor: '#4FA3F7', topColor: 'rgba(79, 163, 247, 0.25)', bottomColor: 'rgba(79, 163, 247, 0.02)', lineWidth: 2, priceFormat: fmt,
    });
    this.bhSeries = this.chart.addSeries(LWC.LineSeries, {
      color: '#8E8A82', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, priceFormat: fmt,
    });
    this.ddSeries = this.chart.addSeries(LWC.AreaSeries, {
      lineColor: '#EC5246', topColor: 'rgba(236, 82, 70, 0.05)', bottomColor: 'rgba(236, 82, 70, 0.3)', lineWidth: 1,
      priceLineVisible: false, priceFormat: { type: 'custom', formatter: (v) => `${fixed(v, 2)}%`, minMove: 0.01 },
      invertFilledArea: true,
    }, 1);
    this.chart.panes()[1]?.setStretchFactor(0.35);
  }

  destroyChart() {
    if (this.chart) { this.chart.remove(); this.chart = null; }
  }

  applyTheme() { if (this.isOpen && this.tab === 'overview') { this.destroyChart(); this.content.innerHTML = ''; this.render(); } }

  describeProps(p) {
    const size = p.sizeType === 'percent' ? t('st.size.percent', { v: p.sizeValue }) : p.sizeType === 'cash' ? t('st.size.cash', { v: money(p.sizeValue) }) : t('st.size.fixed', { v: p.sizeValue });
    return t('st.desc', { capital: money(p.initialCapital), size, commission: p.commission, fill: p.fillOn === 'close' ? t('st.fill.close') : t('st.fill.open') });
  }

  // --- Performance ---------------------------------------------------------------
  renderPerformance(r) {
    const s = r.summary;
    const cols = [s, s.long, s.short];
    const row = (label, f, colorize = false) => `<tr><td>${esc(label)}</td>${cols.map((c) => {
      const v = f(c);
      return `<td class="${colorize ? cls(v.raw) : ''}">${v.text}</td>`;
    }).join('')}</tr>`;
    const m = (k, sign) => (c) => ({ raw: c[k], text: money(c[k], sign) });
    const p = (k) => (c) => ({ raw: c[k], text: pct(c[k], false) });
    const n = (k, d = 0) => (c) => ({ raw: c[k], text: num(c[k], d) });
    const once = (label, value, c = '') => `<tr><td>${esc(label)}</td><td class="${c}">${value}</td><td></td><td></td></tr>`;
    this.content.innerHTML = `<div class="st-table-wrap"><table class="st-table">
      <thead><tr><th></th><th>${t('common.all')}</th><th>${t('common.long')}</th><th>${t('common.short')}</th></tr></thead>
      <tbody>
        ${row(t('st.netProfit'), (c) => ({ raw: c.netProfit, text: `${money(c.netProfit, true)} <small>${pct(c.netProfitPct)}</small>` }), true)}
        ${row(t('st.grossProfit'), m('grossProfit'), false)}
        ${row(t('st.grossLoss'), m('grossLoss'), false)}
        ${row(t('st.profitFactor'), n('profitFactor', 3))}
        ${row(t('st.commissionPaid'), m('commission'))}
        ${row(t('st.totalClosed'), n('trades'))}
        ${row(t('st.winningTrades'), n('wins'))}
        ${row(t('st.losingTrades'), n('losses'))}
        ${row(t('st.percentProfitable'), p('winRate'))}
        ${row(t('st.avgTrade'), (c) => ({ raw: c.avgTrade, text: `${money(c.avgTrade, true)} <small>${pct(c.avgTradePct)}</small>` }), true)}
        ${row(t('st.avgWin'), m('avgWin', true), true)}
        ${row(t('st.avgLoss'), m('avgLoss', true), true)}
        ${row(t('st.ratioWinLoss'), n('ratioWinLoss', 3))}
        ${row(t('st.largestWin'), m('largestWin', true), true)}
        ${row(t('st.largestLoss'), m('largestLoss', true), true)}
        ${row(t('st.avgBars'), n('avgBars', 1))}
        ${row(t('st.maxConsecWins'), n('maxConsecWins'))}
        ${row(t('st.maxConsecLosses'), n('maxConsecLosses'))}
        ${once(t('st.maxDrawdown'), `${money(-s.maxDrawdown)} <small>${pct(-s.maxDrawdownPct)}</small>`, 'down')}
        ${once(t('st.buyHoldReturn'), pct(s.buyHoldPct), cls(s.buyHoldPct))}
        ${once(t('st.sharpe'), num(s.sharpe, 3))}
        ${once(t('st.sortino'), num(s.sortino, 3))}
        ${once(t('st.timeInMarket'), pct(s.exposurePct, false))}
        ${once(t('st.openPnl'), money(s.openPnl, true), cls(s.openPnl))}
        ${once(t('st.finalEquity'), money(s.finalEquity))}
      </tbody></table></div>`;
  }

  // --- List of trades ------------------------------------------------------------
  renderTrades(entry, r) {
    const daily = this.view?.tf.daily;
    const times = entry.times;
    const p = (x) => this.view?.formatPrice(x) ?? num(x);
    const side = (s) => (s === 'long' ? t('common.long') : t('common.short'));
    let cum = 0;
    const rows = r.trades.map((tr, k) => { cum += tr.pnl; return { tr, k: k + 1, cum }; }).reverse();
    const MAX = 1000;
    const open = r.openTrades.map((o) => `<tr class="st-open" data-ei="${o.entryIndex}" data-xi="${times.length - 1}">
        <td>${t('st.open')}</td><td class="${o.side === 'long' ? 'up' : 'down'}">${side(o.side)}</td>
        <td>${esc(o.id)}</td><td>${fmtTime(times[o.entryIndex], daily)}</td><td>${p(o.entryPrice)}</td>
        <td colspan="3" class="muted">${t('st.stillOpen')}</td><td>${num(o.qty, 4)}</td>
        <td class="${cls(o.pnl)}">${money(o.pnl, true)} <small>${pct(o.pnlPct)}</small></td><td></td><td></td><td></td></tr>`).join('');
    const body = rows.slice(0, MAX).map(({ tr, k, cum: c }) => `<tr data-ei="${tr.entryIndex}" data-xi="${tr.exitIndex}">
        <td>${k}</td><td class="${tr.side === 'long' ? 'up' : 'down'}">${side(tr.side)}</td>
        <td>${esc(tr.id)}</td><td>${fmtTime(times[tr.entryIndex], daily)}</td><td>${p(tr.entryPrice)}</td>
        <td>${esc(reasonText(tr.reason))}</td><td>${fmtTime(times[tr.exitIndex], daily)}</td><td>${p(tr.exitPrice)}</td>
        <td>${num(tr.qty, 4)}</td>
        <td class="${cls(tr.pnl)}">${money(tr.pnl, true)} <small>${pct(tr.pnlPct)}</small></td>
        <td class="up">${money(tr.runup)}</td><td class="down">${money(-tr.drawdown)}</td>
        <td class="${cls(c)}">${money(c, true)}</td></tr>`).join('');
    const count = t('st.closedCount', { n: r.trades.length.toLocaleString(locale) }) + (r.trades.length > MAX ? ` ${t('st.newestShown', { max: MAX })}` : '');
    this.content.innerHTML = `<div class="st-trades-head"><span class="muted">${esc(count)} · ${esc(t('st.clickRow'))}</span>
        <button class="tb-btn" data-st="csv">${esc(t('st.exportCsv'))}</button></div>
      <div class="st-table-wrap"><table class="st-table st-trades">
      <thead><tr><th>#</th><th>${t('st.col.type')}</th><th>${t('st.col.signal')}</th><th>${t('st.col.entryTime')}</th><th>${t('st.col.entry')}</th><th>${t('st.col.exitReason')}</th><th>${t('st.col.exitTime')}</th><th>${t('st.col.exit')}</th>
        <th>${t('st.col.qty')}</th><th>${esc(t('st.col.pnl'))}</th><th>${t('st.col.runup')}</th><th>${t('st.drawdown')}</th><th>${esc(t('st.col.cumPnl'))}</th></tr></thead>
      <tbody>${open}${body || `<tr><td colspan="13" class="muted">${t('st.noClosed')}</td></tr>`}</tbody></table></div>`;
  }

  exportCsv() {
    const entry = this.shown; // the chart's result or the range test's, as on screen
    if (!entry?.report) return;
    // Every field quoted; script text that a spreadsheet would run as a formula is kept as text (csv.js).
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tradesCsv(entry.report.trades, entry.times)], { type: 'text/csv' }));
    // An ASCII file name; a name with no Latin letters or digits (a translated one) becomes "strategy".
    const name = entry.def.name.replace(/[^\w-]+/g, '_');
    a.download = `${/[A-Za-z0-9]/.test(name) ? name : 'strategy'}_${this.view.ticker.replace(/[^\w.-]/g, '')}_${this.view.state.tf}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // --- Properties --------------------------------------------------------------
  renderProps(entry, r) {
    const p = r.props;
    const sel = (v, opts) => opts.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
    this.content.innerHTML = `<form class="st-props">
      <label><span>${t('st.initialCapital')}</span><input name="initialCapital" type="number" min="1" step="any" value="${p.initialCapital}"></label>
      <label><span>${t('st.orderSize')}</span><span class="st-pair">
        <input name="sizeValue" type="number" min="0" step="any" value="${p.sizeValue}">
        <select name="sizeType">${sel(p.sizeType, [['percent', t('st.sizeOpt.percent')], ['cash', t('st.sizeOpt.cash')], ['fixed', t('st.sizeOpt.fixed')]])}</select></span></label>
      <label><span>${t('st.commission')}</span><input name="commission" type="number" min="0" step="any" value="${p.commission}"></label>
      <label><span>${t('st.slippage')}</span><input name="slippage" type="number" min="0" step="any" value="${p.slippage}"></label>
      <label><span>${t('st.pyramiding')}</span><input name="pyramiding" type="number" min="1" max="100" step="1" value="${p.pyramiding}"></label>
      <label><span>${t('st.fillOn')}</span><select name="fillOn">${sel(p.fillOn, [['open', t('st.fill.nextBarOpen')], ['close', t('st.fill.close')]])}</select></label>
      <p class="form-note">${esc(t('st.propsNote', { n: r.equity.length.toLocaleString(locale) }))}</p>
      <div class="pop-actions"><button type="button" class="btn-ghost" data-st="reset">${t('st.useDefaults')}</button><button type="submit" class="btn-primary">${t('common.apply')}</button></div>
    </form>`;
  }

  applyProps() {
    const { entry } = this.current();
    const f = this.content.querySelector('.st-props');
    if (!entry || !f) return;
    const v = (k) => f.elements[k].value;
    const numOr = (k, d) => { const x = Number(v(k)); return Number.isFinite(x) ? x : d; };
    const props = {
      initialCapital: Math.max(1, numOr('initialCapital', STRATEGY_DEFAULTS.initialCapital)),
      sizeType: v('sizeType'),
      sizeValue: Math.max(0, numOr('sizeValue', STRATEGY_DEFAULTS.sizeValue)),
      commission: Math.max(0, numOr('commission', 0)),
      slippage: Math.max(0, numOr('slippage', 0)),
      pyramiding: Math.max(1, Math.round(numOr('pyramiding', 1))),
      fillOn: v('fillOn'),
    };
    this.view.setStrategyProps(entry.inst.id, props);
    this.toast(t('st.toastUpdated'));
    // A range test shown runs again with them (its bars are kept, so only the test runs).
    if (this.range.mode === 'range' && this.range.results.has(entry.inst.id)) this.runRange();
  }

  /** What the panel says when there's nothing to show yet. Scripts that only draw buy/sell markers
   *  are easy to mistake for strategies, so name them and point to real strategies. */
  emptyHtml(entry) {
    if (entry?.error) return `<div class="st-empty"><b>${esc(t('st.errorStopped', { name: entry.def?.name || t('st.thisStrategy') }))}</b><span>${esc(entry.error)}</span></div>`;
    if (entry) return `<div class="st-empty"><b>${t('st.running')}</b></div>`;
    const browse = this.browseStrategies ? `<button type="button" class="btn-primary st-browse" data-st="browse">${t('st.browse')}</button>` : '';
    const howTo = `<span>${t('st.howTo')}</span>`;
    const live = [...(this.view?.live?.values() || [])];
    // A script that failed before its first run has no definition yet, so it may be a strategy that never started.
    const failed = live.filter((e) => e.error && !e.def?.strategy && e.inst.scriptId);
    if (failed.length) {
      const e = failed[0];
      return `<div class="st-empty"><b>${esc(t('st.errorStopped', { name: e.def?.name || e.name || t('st.aScript') }))}</b>
        <span>${esc(e.error)}</span><span>${t('st.fixInEditor')}</span></div>`;
    }
    const lookalikes = live.filter((e) => e.def?.script && !e.def.strategy).map((e) => e.def.name);
    if (lookalikes.length) {
      const quoted = lookalikes.slice(0, 3).map((n) => t('st.quoted', { name: n }));
      let names;
      try { names = new Intl.ListFormat(locale, { type: 'conjunction' }).format(quoted); } catch { names = quoted.join(', '); }
      return `<div class="st-empty">
        <b>${t('st.noStrategy')}</b>
        <span>${esc(t('st.lookalike', { n: lookalikes.length, names }))}
        ${t('st.strategyStarts')}</span>
        ${howTo}${browse}</div>`;
    }
    return `<div class="st-empty"><b>${t('st.noStrategy')}</b>${howTo}${browse}</div>`;
  }

  onClick(e) {
    const act = e.target.closest('[data-st]')?.dataset.st;
    if (act === 'browse') { this.browseStrategies?.(); return; }
    if (act === 'csv') { this.exportCsv(); return; }
    if (act === 'cancel') { this.cancelRange(); return; }
    if (act === 'alpaca') { this.alpacaKey?.(); return; }
    if (act === 'reset') {
      const { entry } = this.current();
      if (entry) { this.view.setStrategyProps(entry.inst.id, undefined); this.toast(t('st.toastDefaults')); }
      return;
    }
    const row = e.target.closest('tr[data-ei]');
    if (row && this.view) {
      const rg = this.shown?.range;
      if (!rg) this.view.focusBars(Number(row.dataset.ei), Number(row.dataset.xi));
      else if (!this.view.focusTimes(rg.times[Number(row.dataset.ei)], rg.times[Number(row.dataset.xi)])) this.toast(t('st.range.notOnChart'));
      this.content.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel'));
      row.classList.add('sel');
    }
  }
}
