// Symbol search extras (lib/search-aliases.mjs). Run: node test/search-aliases.test.mjs
import assert from 'node:assert/strict';
import { metalFutures } from '../lib/search-aliases.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };
const sym = (q) => metalFutures(q).map((r) => r.symbol).join(',');

ok('spot metals written the forex way find the futures', () => {
  assert.equal(sym('XAUUSD'), 'GC=F');
  assert.equal(sym('xau/usd'), 'GC=F');
  assert.equal(sym(' XAU '), 'GC=F');
  assert.equal(sym('XAGUSD'), 'SI=F');
  assert.equal(sym('XPT'), 'PL=F');
  assert.equal(sym('XPD/USD'), 'PA=F');
  assert.equal(metalFutures('XAUUSD')[0].quoteType, 'FUTURE');
});

ok('anything else adds nothing', () => {
  for (const q of ['XAUT', 'XAUEUR', 'gold', 'AAPL', '', null]) assert.equal(sym(q), '', q);
});

console.log(`search-aliases: ${n} checks passed`);
