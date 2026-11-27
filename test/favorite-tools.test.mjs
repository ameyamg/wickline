// Favorite drawing tools: validated settings, insertion order, persistence and window sync.
import assert from 'node:assert/strict';
import { cleanFavorites, cleanPosition, clampPosition, DEFAULT_POSITION, FavoriteToolsState, FAVORITE_TOOLS_KEY, FAVORITE_POSITION_KEY } from '../public/js/favorite-tools.js';
import { TOOLS } from '../public/js/drawings.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };
const memory = () => {
  const data = new Map();
  return { get: (k, fallback) => data.has(k) ? JSON.parse(data.get(k)) : fallback, set: (k, v) => data.set(k, JSON.stringify(v)), clear: () => data.clear() };
};
const event = (events, key) => {
  const e = new Event('storage');
  Object.defineProperty(e, 'key', { value: key });
  events.dispatchEvent(e);
};

ok('every drawing tool can be favorited; the cursor and toolbar actions cannot', () => {
  const ids = Object.keys(TOOLS).filter((id) => id !== 'cursor');
  assert.deepEqual(cleanFavorites(ids), ids);
  assert.deepEqual(cleanFavorites(['cursor', 'magnet', 'clear', 'toString', '__proto__']), []);
});

ok('saved ids are checked, deduplicated and kept in their original order', () => {
  assert.deepEqual(cleanFavorites(['fib', null, 'trend', 'fib', {}, 4, 'removed-tool', 'arrowUp']), ['fib', 'trend', 'arrowUp']);
  for (const raw of [null, {}, 'trend', 17]) assert.deepEqual(cleanFavorites(raw), []);
});

ok('a new profile starts empty without writing defaults into storage', () => {
  const storage = memory();
  const s = new FavoriteToolsState({ storage });
  assert.deepEqual(s.tools, []);
  assert.deepEqual(s.position, DEFAULT_POSITION);
  assert.equal(storage.get(FAVORITE_TOOLS_KEY, null), null);
});

ok('starring, unstarring and starring again save the displayed order', () => {
  const storage = memory();
  const s = new FavoriteToolsState({ storage });
  s.toggle('trend'); s.toggle('fib'); s.toggle('hline');
  assert.deepEqual(s.tools, ['trend', 'fib', 'hline']);
  s.toggle('fib');
  assert.equal(s.has('fib'), false);
  assert.deepEqual(storage.get(FAVORITE_TOOLS_KEY), ['trend', 'hline']);
  s.toggle('fib');
  assert.deepEqual(s.tools, ['trend', 'hline', 'fib']);
  s.toggle('cursor'); s.toggle('invalid');
  assert.deepEqual(s.tools, ['trend', 'hline', 'fib']);
});

ok('every local edit notifies both menu and bar subscribers immediately', () => {
  const s = new FavoriteToolsState({ storage: memory() });
  const menu = [], bar = [];
  s.onChange((kind) => menu.push([kind, s.has('trend')]));
  const off = s.onChange((kind) => bar.push([kind, s.has('trend')]));
  s.toggle('trend'); s.toggle('trend'); off(); s.toggle('fib');
  assert.deepEqual(menu, [['tools', true], ['tools', false], ['tools', false]]);
  assert.deepEqual(bar, [['tools', true], ['tools', false]]);
});

ok('a fresh state restores favorites, order and toolbar position', () => {
  const storage = memory();
  const s = new FavoriteToolsState({ storage });
  s.toggle('rect'); s.toggle('trend'); s.setPosition({ x: 342.5, y: 186 });
  const restored = new FavoriteToolsState({ storage });
  assert.deepEqual(restored.tools, ['rect', 'trend']);
  assert.deepEqual(restored.position, { x: 342.5, y: 186 });
});

ok('other windows update both kinds of settings, and unrelated storage is ignored', () => {
  const storage = memory(), events = new EventTarget();
  const s = new FavoriteToolsState({ storage, events });
  const changes = [];
  s.onChange((kind) => changes.push(kind));
  storage.set(FAVORITE_TOOLS_KEY, ['fib', 'trend']);
  storage.set(FAVORITE_POSITION_KEY, { x: 100, y: 200 });
  event(events, 'wickline.workspace');
  assert.deepEqual(changes, []);
  event(events, `wickline.${FAVORITE_TOOLS_KEY}`);
  event(events, `wickline.${FAVORITE_POSITION_KEY}`);
  assert.deepEqual(s.tools, ['fib', 'trend']);
  assert.deepEqual(s.position, { x: 100, y: 200 });
  assert.deepEqual(changes, ['tools', 'position']);
  storage.clear(); event(events, null);
  assert.deepEqual(s.tools, []);
  assert.deepEqual(s.position, DEFAULT_POSITION);
  s.destroy(); event(events, null);
  assert.equal(changes.length, 4);
});

ok('a toggle preserves a recent edit made in another window', () => {
  const storage = memory();
  const s = new FavoriteToolsState({ storage });
  storage.set(FAVORITE_TOOLS_KEY, ['avwap']);
  s.toggle('trend');
  assert.deepEqual(s.tools, ['avwap', 'trend']);
});

ok('invalid and old positions fall back safely, without retaining arbitrary fields', () => {
  for (const p of [null, [], {}, { x: '5', y: 2 }, { x: Infinity, y: NaN }]) assert.deepEqual(cleanPosition(p), DEFAULT_POSITION);
  assert.deepEqual(cleanPosition({ x: -20, y: -1, other: true }), { x: 0, y: 0 });
});

ok('dragging to any edge keeps the entire toolbar within the chart area', () => {
  const area = { width: 800, height: 500 }, bar = { width: 200, height: 44 };
  assert.deepEqual(clampPosition({ x: 9999, y: 9999 }, area, bar), { x: 592, y: 448 });
  assert.deepEqual(clampPosition({ x: -9999, y: -9999 }, area, bar), { x: 8, y: 8 });
  assert.deepEqual(clampPosition({ x: 100, y: 120 }, area, bar), { x: 100, y: 120 });
});

ok('resizing clamps the display without losing the saved position for a larger window', () => {
  const position = { x: 600, y: 400 }, bar = { width: 200, height: 44 };
  assert.deepEqual(clampPosition(position, { width: 400, height: 200 }, bar), { x: 192, y: 148 });
  assert.deepEqual(clampPosition(position, { width: 1000, height: 700 }, bar), position);
  assert.deepEqual(clampPosition(position, { width: 100, height: 20 }, bar), { x: 0, y: 0 });
});

console.log(`favorite tools: ${n} checks passed`);
