// Symbol search extras: what people type that Yahoo's search doesn't find. Pure, unit-tested in
// test/search-aliases.test.mjs.

/**
 * Spot metals written the forex way (XAUUSD, XAU/USD, XAG…) have no Yahoo quote of their own: Yahoo's
 * gold and silver are the COMEX / NYMEX futures. Rows for those, in Yahoo search's shape, to show first
 * (the crypto exchanges' XAU / XAG perpetuals are found by their own search).
 */
const METALS = {
  XAU: { symbol: 'GC=F', name: 'Gold futures (COMEX)', exchange: 'COMEX' },
  XAG: { symbol: 'SI=F', name: 'Silver futures (COMEX)', exchange: 'COMEX' },
  XPT: { symbol: 'PL=F', name: 'Platinum futures (NYMEX)', exchange: 'NYMEX' },
  XPD: { symbol: 'PA=F', name: 'Palladium futures (NYMEX)', exchange: 'NYMEX' },
};

export function metalFutures(q) {
  const m = /^(XAU|XAG|XPT|XPD)\s*\/?\s*(USD)?$/i.exec(String(q || '').trim());
  if (!m) return [];
  // alias: what the user typed means this symbol, so the search ranks it like an exact match.
  return [{ ...METALS[m[1].toUpperCase()], type: 'Futures', quoteType: 'FUTURE', alias: true }];
}
