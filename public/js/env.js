// Where stock data comes from. Wickline is a static site; a server is optional.
//
//  'static' (default, e.g. GitHub Pages): crypto straight from the exchanges, no keys.
//           Stocks, ETFs, forex and indices: history from Twelve Data with the visitor's own
//           free key (kept in their browser), live prices from Yahoo's public stream.
//  'server': the optional Wickline server (server.mjs) answered at <apiBase>api/health.
//           Stocks come from Yahoo through it, no key needed.

import { store } from './util.js';

const listeners = new Set();

export const settings = {
  /** Base URL of an optional Wickline server ('' = the same site the page came from). */
  get apiBase() { return store.get('apiBase', ''); },
  /** The visitor's own Twelve Data API key (stored only in this browser). */
  get tdKey() { return store.get('tdKey', ''); },
  /** Twelve Data requests per minute (8 on the free plan). */
  get tdRate() { return Number(store.get('tdRate', 8)) || 8; },
  set(key, value) {
    store.set(key, value);
    listeners.forEach((fn) => fn(key));
  },
};

export const onSettingsChange = (fn) => listeners.add(fn);

/** URL of an endpoint on the optional server. */
export function apiUrl(path) {
  const base = settings.apiBase.trim();
  return base ? `${base.replace(/\/+$/, '')}/${path}` : path;
}

let mode = null;
let detecting = null;
let features = [];

/** Resolves to 'server' or 'static'. Checked once per page load. */
export function dataMode() {
  if (!detecting) {
    detecting = (async () => {
      try {
        const r = await fetch(apiUrl('api/health'), { cache: 'no-store', signal: AbortSignal.timeout(2500) });
        const j = r.ok ? await r.json().catch(() => null) : null;
        mode = j?.app === 'wickline' ? 'server' : 'static';
        features = Array.isArray(j?.features) ? j.features : [];
      } catch {
        mode = 'static';
      }
      return mode;
    })();
  }
  return detecting;
}

export const isServerMode = () => mode === 'server';

/**
 * Whether this page's own server keeps downloaded history (js/history.js). Only for the server the
 * page came from: its history endpoints answer nothing else.
 */
export const hasHistory = () => mode === 'server' && features.includes('history') && !settings.apiBase.trim();
