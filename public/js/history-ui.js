// Downloaded history in the app's UI: a small downloads indicator in the status bar (only while
// something downloads) with a list of the downloads, and the settings in Data sources (automatic
// downloads, size limit, the Alpaca key). js/history.js talks to the server.

import { t, locale } from './i18n.js';
import { esc } from './util.js';
import { historyReady, historyStatus, onHistoryStatus, watchDownloads, cancelDownload, deleteHistory, saveHistorySettings, formatBytes } from './history.js';

const $ = (s) => document.querySelector(s);
const active = (j) => j.state === 'queued' || j.state === 'running';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>';

/** The indicator and its list. openSettings: opens Data sources. */
export async function initHistoryUI({ openSettings }) {
  if (!(await historyReady())) return;
  const btn = $('#dl-btn'), pop = $('#dl-pop');
  let status = null;

  const renderButton = () => {
    const n = status?.jobs.filter((j) => active(j) && !j.topUp).length || 0; // a top-up of this month's newest bars isn't a download to show
    btn.hidden = !n && pop.hidden;
    btn.innerHTML = `${ICON_DOWN}<span>${n || ''}</span>`;
    btn.title = t('hist.dl.title');
    btn.setAttribute('aria-label', t('hist.dl.title'));
  };

  const jobLine = (j) => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 100;
    const state = j.state === 'error' ? (j.error === 'alpaca-auth' ? t('hist.dl.alpacaAuth') : t('hist.dl.failed'))
      : j.state === 'cancelled' ? t('hist.dl.cancelled') : j.state === 'done' ? t('hist.dl.done')
        : t('hist.dl.months', { done: j.done, total: j.total });
    return `<div class="dl-job${active(j) ? '' : ' ended'}">
      <div class="dl-row"><b>${esc(j.label)}</b><span class="dl-state">${esc(state)}${j.bytes ? ` · ${formatBytes(j.bytes, locale)}` : ''}</span>
        ${active(j) ? `<button data-dl-cancel="${j.id}" title="${esc(t('hist.dl.cancel'))}" aria-label="${esc(t('hist.dl.cancel'))}">×</button>` : ''}</div>
      <div class="dl-bar"><i style="width:${pct}%"></i></div></div>`;
  };

  const renderPop = () => {
    const jobs = status?.jobs || [];
    pop.innerHTML = `<div class="pop-title">${esc(t('hist.dl.title'))}</div>
      ${jobs.length ? jobs.map(jobLine).join('') : `<p class="pop-note">${esc(t('hist.dl.none'))}</p>`}
      <div class="dl-foot"><span>${esc(t('hist.dl.used', { size: formatBytes(status?.totalBytes || 0, locale) }))}</span>
        <button class="link-btn" data-dl-settings>${esc(t('common.settings'))}</button></div>`;
  };

  const place = () => {
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 6}px`;
  };

  onHistoryStatus((s) => {
    status = s;
    renderButton();
    if (!pop.hidden) renderPop();
  });
  watchDownloads();
  btn.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { renderPop(); place(); watchDownloads(); }
    renderButton();
  });
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) { pop.hidden = true; renderButton(); }
  });
  pop.addEventListener('click', (e) => {
    const c = e.target.closest('[data-dl-cancel]');
    if (c) cancelDownload(Number(c.dataset.dlCancel));
    if (e.target.closest('[data-dl-settings]')) { pop.hidden = true; renderButton(); openSettings(); }
  });
  wireSettings();
}

// --- Data sources: the history section ------------------------------------------------------------

function fill(s) {
  $('#set-hist-auto').checked = !!s.auto;
  const cap = $('#set-hist-cap');
  if (![...cap.options].some((o) => o.value === String(s.capGB))) cap.add(new Option(`${s.capGB} GB`, String(s.capGB)));
  cap.value = String(s.capGB);
  $('#set-hist-used').textContent = t('hist.set.used', { size: formatBytes(s.totalBytes || 0, locale), cap: `${s.capGB} GB` });
  $('#set-alpaca-id').value = '';
  $('#set-alpaca-secret').value = '';
  $('#set-alpaca-id').placeholder = s.alpaca?.keyId || '';
  const st = $('#set-alpaca-status');
  st.textContent = s.alpaca ? t('hist.set.connected', { key: s.alpaca.keyId }) : '';
  st.className = s.alpaca ? 'ok' : '';
  $('#set-alpaca-remove').hidden = !s.alpaca;
}

/** Called when Data sources opens: shows the section when history works here, with the current settings. */
export async function openHistorySettings() {
  const box = $('#set-history');
  box.hidden = true;
  if (!(await historyReady())) return;
  const s = await historyStatus().catch(() => null);
  if (!s) return;
  fill(s);
  box.hidden = false;
}

let wired = false;
function wireSettings() {
  if (wired) return;
  wired = true;
  const say = (text, cls = '') => { const st = $('#set-alpaca-status'); st.textContent = text; st.className = cls; };
  $('#set-hist-auto').addEventListener('change', (e) => saveHistorySettings({ auto: e.target.checked }).then(fill).catch(() => {}));
  $('#set-hist-cap').addEventListener('change', (e) => saveHistorySettings({ capGB: Number(e.target.value) }).then(fill).catch(() => {}));
  $('#set-hist-delete').addEventListener('click', async () => {
    if (!window.confirm(t('hist.set.deleteConfirm'))) return;
    fill(await deleteHistory());
  });
  const connect = async () => {
    const keyId = $('#set-alpaca-id').value.trim(), secret = $('#set-alpaca-secret').value.trim();
    if (!keyId || !secret) { say(t('hist.set.bothParts'), 'err'); return; }
    say(t('hist.set.checking'));
    try {
      const s = await saveHistorySettings({ alpaca: { keyId, secret } });
      if (s.alpacaError) { say(s.alpacaError === 'auth' || s.alpacaError === 'empty' ? t('hist.set.badKey') : t('hist.set.keyError', { error: s.alpacaError }), 'err'); return; }
      fill(s);
    } catch (e) {
      say(t('hist.set.keyError', { error: e.message }), 'err');
    }
  };
  $('#set-alpaca-save').addEventListener('click', connect);
  for (const id of ['#set-alpaca-id', '#set-alpaca-secret']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });
  }
  $('#set-alpaca-remove').addEventListener('click', async () => { fill(await saveHistorySettings({ alpaca: null })); say(t('hist.set.removed')); });
}
