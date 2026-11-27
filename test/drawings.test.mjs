// Drawing tools: Shift snaps lines to horizontal (0°) while placing or dragging, and the magnet
// snaps drawing points to a bar's open, high, low or close. Run: node test/drawings.test.mjs
import assert from 'node:assert/strict';
import { DrawingLayer, MAGNET_MODES, SYMBOL_SIZE, TOOLS, anchoredVwap, isSymbol } from '../public/js/drawings.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

// A chart where x = bar * 10 (one bar every 10 px) and y = (100 - price) * 10.
function makeLayer() {
  const chart = { timeScale: () => ({
    coordinateToLogical: (x) => x / 10,
    logicalToCoordinate: (l) => l * 10,
    width: () => 800,
  }) };
  const series = { coordinateToPrice: (y) => 100 - y / 10, priceToCoordinate: (p) => (100 - p) * 10 };
  const layer = new DrawingLayer({ formatPrice: (v) => String(v) });
  layer.attached({ chart, series, requestUpdate() {} });
  // Every bar: open 50, high 60, low 40, close 55 (at y = 500, 400, 600, 450).
  layer.setBars(Array.from({ length: 100 }, (_, i) => ({ time: 1000 * i, open: 50, high: 60, low: 40, close: 55 })));
  layer.setContext('TEST', 1000);
  return layer;
}

/** A canvas context that records its calls. */
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 8 })
      : k === 'roundRect' ? undefined : (...a) => calls.push([k, ...a])),
    set: (_, k, v) => { calls.push(['set', k, v]); return true; },
  });
  return { ctx, calls };
}

const place = (layer, tool, a, b, shift = false) => {
  layer.setTool(tool);
  layer.handleClick({ point: a });
  layer.handleClick({ point: b, shift });
  return layer.items.at(-1);
};

ok('Shift while placing a trend line keeps the preview at 0°', () => {
  const l = makeLayer();
  l.setTool('trend');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleMove({ point: { x: 500, y: 700 }, sourceEvent: { shiftKey: true } });
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  assert.equal(l.pending.p2.time, 50000, 'the end still follows the pointer in time');
  l.handleMove({ point: { x: 500, y: 700 }, sourceEvent: { shiftKey: false } });
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
});

ok('the second click with Shift places a perfectly horizontal line', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, true);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p2.time, 60000);
});

ok('without Shift the line is left as drawn', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, false);
  assert.notEqual(d.p2.price, d.p1.price);
});

ok('pressing and releasing Shift re-applies it without moving the mouse', () => {
  const l = makeLayer();
  l.setTool('ray');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleMove({ point: { x: 400, y: 600 } });
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
  l.setShift(true);
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  l.setShift(false);
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
});

ok('Shift applies to ray, extended line and arrow, not to a rectangle', () => {
  for (const tool of ['ray', 'extended', 'arrow']) {
    const d = place(makeLayer(), tool, { x: 100, y: 300 }, { x: 600, y: 120 }, true);
    assert.equal(d.p2.price, d.p1.price, tool);
  }
  const r = place(makeLayer(), 'rect', { x: 100, y: 300 }, { x: 600, y: 120 }, true);
  assert.notEqual(r.p2.price, r.p1.price);
});

ok('a channel flattens its first side; the width click stays free', () => {
  const l = makeLayer();
  l.setTool('channel');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleClick({ point: { x: 600, y: 120 }, shift: true });
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  l.handleClick({ point: { x: 350, y: 500 }, shift: true });
  const d = l.items.at(-1);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p3.price, 100 - 500 / 10);
});

ok('Shift while dragging an end handle keeps it level with the other end', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, false);
  assert.ok(l.beginDrag(600, 120), 'grabs the p2 handle');
  l.dragMove(700, 50, true);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p2.time, 70000);
  l.dragMove(700, 50, false);
  assert.notEqual(d.p2.price, d.p1.price);
  l.endDrag();
});

// --- magnet ---------------------------------------------------------------------------
const click = (l, x, y) => { l.handleClick({ point: { x, y } }); return l.items.at(-1); };

ok('the magnet is off by default and ignores bad modes', () => {
  const l = makeLayer();
  assert.deepEqual(MAGNET_MODES, ['off', 'weak', 'strong']);
  assert.equal(l.magnet, 'off');
  l.setMagnet('nonsense');
  assert.equal(l.magnet, 'off');
  l.setTool('hline');
  assert.equal(click(l, 100, 430).p1.price, 57, 'untouched with the magnet off');
});

ok('strong magnet snaps to the nearest of open, high, low and close, however far', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.setTool('hline');
  assert.equal(click(l, 100, 430).p1.price, 55, 'closer to the close (y 450) than to the high (y 400)');
  l.setTool('hline');
  assert.equal(click(l, 100, 380).p1.price, 60, 'the high');
  l.setTool('hline');
  assert.equal(click(l, 100, 700).p1.price, 40, 'the low, even far below the bar');
  l.setTool('hline');
  assert.equal(click(l, 100, 495).p1.price, 50, 'the open');
});

ok('weak magnet snaps only when the pointer is close, and leaves the price alone otherwise', () => {
  const l = makeLayer();
  l.setMagnet('weak');
  l.setTool('hline');
  assert.equal(click(l, 100, 440).p1.price, 55, '10 px from the close');
  l.setTool('hline');
  assert.equal(click(l, 100, 425).p1.price, 57.5, '25 px from anything: unchanged');
});

ok('the magnet also snaps a point being dragged, but not a drawing moved as a whole', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 450 }, { x: 600, y: 520 }, false);
  l.setMagnet('strong');
  assert.ok(l.beginDrag(600, 520), 'grabs the p2 handle');
  l.dragMove(700, 590);
  assert.equal(d.p2.price, 40, 'the handle snaps to the low');
  l.endDrag();
  // The line now runs (100, 450) → (700, 600); grab it in the middle and move it 45 px up.
  assert.ok(l.beginDrag(400, 525), 'grabs the line, not a handle');
  l.dragMove(400, 480);
  l.endDrag();
  assert.equal(d.p1.price, 59.5, 'moved by the pointer (+4.5), not snapped to a bar value');
});

ok('past the last bar there is nothing to snap to', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.setTool('hline');
  assert.equal(click(l, 2000, 430).p1.price, 57);
});

ok('Shift and the magnet work together: the first point snaps, the line is level', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  const d = place(l, 'trend', { x: 100, y: 430 }, { x: 600, y: 700 }, true);
  assert.equal(d.p1.price, 55);
  assert.equal(d.p2.price, 55);
});

ok('a ring marks where the magnet snaps while a tool is selected, and goes away after', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.equal(l.hint, null, 'cursor tool: no ring');
  l.setTool('trend');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.deepEqual(l.hint, { time: 10000, price: 55 });
  l.handleMove({ point: undefined });
  assert.equal(l.hint, null, 'pointer left the chart');
  l.handleMove({ point: { x: 100, y: 430 } });
  l.setMagnet('off');
  assert.equal(l.hint, null, 'magnet turned off');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.equal(l.hint, null);
});

// Long/short positions: a click-click on one candle used to leave a box with no width (only its
// labels showing) that nothing could select or delete.
ok('a long placed with both clicks on one candle gets a ready-made size, target above, stop below', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 302, y: 501 });
  assert.ok(l.logicalFromTime(d.p2.time) - l.logicalFromTime(d.p1.time) >= 5, 'at least 5 bars wide');
  assert.ok(d.p2.price > d.p1.price, 'target above the entry');
  assert.ok(d.p3.price < d.p1.price, 'stop below the entry');
  assert.equal(l.hitTest(305, 500), d.id, 'it can be picked up');
});

ok('a short placed with one click-click points down', () => {
  const l = makeLayer();
  const d = place(l, 'short', { x: 300, y: 500 }, { x: 300, y: 500 });
  assert.ok(d.p2.price < d.p1.price && d.p3.price > d.p1.price);
});

ok('a long drawn as usual keeps the size it was drawn with', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 500, y: 300 });
  assert.equal(d.p2.time, 50000);
  assert.equal(d.p2.price, 70);
  assert.equal(d.p3.price, 30);
});

ok('a very thin position can still be selected (a few pixels of margin)', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 500, y: 300 });
  l.select(null);
  assert.equal(l.hitTest(296, 400), d.id, 'just left of the box');
  assert.equal(l.hitTest(250, 400), null, 'well outside it');
});

ok('while a long is being placed it previews (no stop yet) without errors', () => {
  const l = makeLayer();
  l.setTool('long');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.handleMove({ point: { x: 450, y: 350 } });
  assert.ok(l.pending && !l.pending.p3);
  assert.deepEqual(l._handles(l.pending).map(([h]) => h), ['p1', 'p2']);
});

ok('anchored VWAP: volume-weighted typical price from the anchor on; equal weights when there is no volume', () => {
  const bars = [
    { high: 12, low: 8, close: 10, volume: 100 }, // typical 10
    { high: 24, low: 18, close: 21, volume: 300 }, // typical 21
    { high: 30, low: 30, close: 30, volume: 0 }, // no volume: no weight
  ];
  assert.deepEqual(anchoredVwap(bars, 0), [10, (10 * 100 + 21 * 300) / 400, (10 * 100 + 21 * 300) / 400]);
  assert.deepEqual(anchoredVwap(bars, 1), [21, 21]);
  assert.deepEqual(anchoredVwap(bars.map((b) => ({ ...b, volume: 0 })), 0), [10, 15.5, 61 / 3]);
  assert.deepEqual(anchoredVwap(bars, 5), []);
});

ok('anchored VWAP drawing: one click anchors it at that bar; it can be picked up on its line, not off it', () => {
  const l = makeLayer(); // every bar's typical price: (60 + 40 + 55) / 3
  l.setTool('avwap');
  l.handleClick({ point: { x: 300, y: 200 } });
  const d = l.items.at(-1);
  assert.equal(d.type, 'avwap');
  const { from, values } = l._vwap(d);
  assert.equal(from, 30);
  assert.equal(values.length, 70);
  const y = (100 - 155 / 3) * 10;
  assert.ok(Math.abs(l._y(values[10]) - y) < 1e-9);
  l.select(null);
  assert.equal(l.hitTest(500, y + 2), d.id, 'on the line');
  assert.equal(l.hitTest(250, y), null, 'before the anchor');
  assert.equal(l.hitTest(500, y + 60), null, 'far from the line');
  const [[name, hx, hy]] = l._handles(d);
  assert.deepEqual([name, hx, Math.round(hy)], ['p1', 300, Math.round(y)]);
  assert.ok(!Object.keys(d).some((k) => k.startsWith('_vwap')), 'the cache is not saved with the drawing');
});

// --- arrow symbols -------------------------------------------------------------------------
ok('arrow symbols are one-point tools with a label and size', () => {
  assert.ok(isSymbol('arrowUp') && isSymbol('arrowDown') && !isSymbol('trend'));
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  assert.equal(d.type, 'arrowDown');
  assert.equal(d.text, '');
  assert.equal(d.size, SYMBOL_SIZE.default);
  assert.equal(l.tool, 'cursor', 'back to the cursor after placing');
  assert.equal(l.selectedId, d.id);
  assert.equal(l.focusText, true);
});

ok('the label and size can be edited, and size stays within its limits', () => {
  const l = makeLayer();
  l.setTool('arrowUp');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.updateSelected({ text: '17', size: 24 });
  assert.equal(l.selected.text, '17');
  assert.equal(l.selected.size, 24);
  l.updateSelected({ size: 999 });
  assert.equal(l.selected.size, SYMBOL_SIZE.max);
  l.updateSelected({ size: 1 });
  assert.equal(l.selected.size, SYMBOL_SIZE.min);
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 400, y: 500 } });
  assert.equal(l.items[1].size, SYMBOL_SIZE.min, 'the next symbol starts at the last size used');
});

ok('▼ sits above its price with the label on top; ▲ below with the label underneath', () => {
  const l = makeLayer();
  const down = l._symbolGeom({ type: 'arrowDown', size: 20 }, 300, 500);
  assert.ok(down.tipY < 500 && down.tailY < down.tipY && down.labelY < down.tailY);
  const up = l._symbolGeom({ type: 'arrowUp', size: 20 }, 300, 500);
  assert.ok(up.tipY > 500 && up.tailY > up.tipY && up.labelY > up.tailY);
});

ok('a symbol is selectable by clicking its arrow or label, and not far away', () => {
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.updateSelected({ text: 'Sell 13', size: 20 });
  const id = l.items[0].id;
  assert.equal(l.hitTest(300, 480), id, 'on the arrow');
  assert.equal(l.hitTest(300, 440), id, 'on the label');
  assert.equal(l.hitTest(300, 560), null);
  assert.equal(l.hitTest(600, 480), null);
});

ok('dragging a symbol moves it', () => {
  const l = makeLayer();
  l.setTool('arrowUp');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  assert.ok(l.beginDrag(300, 515));
  l.dragMove(400, 415);
  l.endDrag();
  assert.equal(d.p1.time, 40000);
  assert.equal(Math.round(d.p1.price), 60); // 50 + the 10 the pointer moved up
});

ok('drawing a symbol paints the arrow and the label, and survives a missing label', () => {
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  let r = recorder();
  l._drawItem(r.ctx, d, { width: 800, height: 600 }, false);
  assert.ok(r.calls.some((c) => c[0] === 'fill'));
  assert.ok(!r.calls.some((c) => c[0] === 'fillText'), 'no label, no text');
  l.updateSelected({ text: '13', size: 30 });
  r = recorder();
  l._drawItem(r.ctx, d, { width: 800, height: 600 }, true);
  const text = r.calls.find((c) => c[0] === 'fillText');
  assert.deepEqual(text.slice(0, 2), ['fillText', '13']);
  assert.ok(r.calls.some((c) => c[0] === 'set' && c[1] === 'font' && String(c[2]).includes('30px')));
  assert.ok(r.calls.some((c) => c[0] === 'arc'), 'selected: a handle is drawn');
});

ok('a point between two bars sits between them, not at the left edge (#14)', () => {
  const l = makeLayer();
  // Like the chart library: an index between two bars gives 0.
  const ts = { coordinateToLogical: (x) => x / 10, logicalToCoordinate: (i) => (Number.isInteger(i) ? i * 10 : 0), width: () => 800 };
  l.chart = { timeScale: () => ts };
  assert.equal(l._x(5000), 50, 'on a bar');
  assert.equal(l._x(5250), 52.5, 'a quarter of the way to the next bar');
  assert.equal(l._x(99500), 995, 'half a bar after the last one');
});

ok('a line\'s label sits where the user put it (#18)', () => {
  const l = makeLayer();
  const at = (d) => {
    const r = recorder();
    l._drawItem(r.ctx, d, { width: 800, height: 600 }, false);
    const i = r.calls.findIndex((c) => c[0] === 'fillText');
    const align = r.calls.slice(0, i).filter((c) => c[0] === 'set' && c[1] === 'textAlign').at(-1)?.[2];
    return [r.calls[i][2], align];
  };
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 500, y: 300 });
  l.updateSelected({ label: 'Hi' });
  assert.deepEqual(at(d), [300, 'center'], 'a line: above its middle by default');
  l.updateSelected({ labelPos: 'left' });
  assert.deepEqual(at(d), [106, 'left']);
  l.updateSelected({ labelPos: 'right' });
  assert.deepEqual(at(d), [494, 'right']);
  l.setTool('hline');
  l.handleClick({ point: { x: 300, y: 500 } });
  const h = l.items.at(-1);
  l.updateSelected({ label: 'Level' });
  assert.deepEqual(at(h), [792, 'right'], 'a horizontal line: at the right edge by default');
  l.updateSelected({ labelPos: 'left' });
  assert.deepEqual(at(h), [8, 'left']);
  l.updateSelected({ labelPos: 'center' });
  assert.deepEqual(at(h), [400, 'center']);
});

ok('Duplicate (Ctrl+D) puts a selected copy on top: same points and look, new id, unlocked (#15)', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 300, y: 200 });
  l.updateSelected({ color: '#2962FF', width: 3, style: 'dashed', locked: true });
  assert.ok(l.duplicateSelected());
  assert.equal(l.items.length, 2);
  const c = l.items[1];
  assert.notEqual(c.id, d.id);
  assert.equal(l.selected, c);
  assert.deepEqual([c.type, c.color, c.width, c.style, c.p1, c.p2], [d.type, d.color, d.width, d.style, d.p1, d.p2]);
  assert.equal(c.locked, undefined, 'the copy is free to move');
  assert.equal(d.locked, true, 'the original keeps its lock');
  c.p1.price = 1; // a deep copy
  assert.notEqual(d.p1.price, 1);
  l.select(null);
  assert.equal(l.duplicateSelected(), false, 'nothing selected');
});

ok('a locked drawing is selected but not dragged; unlocked, it moves again (#15)', () => {
  const l = makeLayer();
  l.setTool('arrowUp');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  assert.ok(l.toggleLockSelected());
  assert.equal(d.locked, true);
  l.select(null);
  assert.equal(l.beginDrag(300, 515), false, 'no drag on the body');
  assert.equal(l.selected, d, 'but it is selected');
  assert.equal(l.beginDrag(300, 500), false, 'no drag on a handle either');
  assert.deepEqual([d.p1.time, d.p1.price], [30000, 50]);
  l.updateSelected({ text: 'still editable' });
  assert.equal(d.text, 'still editable');
  l.toggleLockSelected();
  assert.equal(d.locked, undefined);
  assert.ok(l.beginDrag(300, 515));
  l.dragMove(400, 415);
  l.endDrag();
  assert.equal(d.p1.time, 40000);
  l.toggleLockSelected();
  assert.ok(l.deleteSelected(), 'a locked drawing can still be deleted');
  assert.equal(l.items.length, 0);
});

ok('undo / redo (#22): placing, moving, restyling, deleting and clearing are each one step', () => {
  const l = makeLayer();
  const pts = (d) => [d.p1.time, d.p1.price, d.p2.time, d.p2.price];
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 300, y: 200 });
  const placed = pts(d);
  l.setTool('cursor');
  assert.ok(l.beginDrag(200, 250));
  l.dragMove(250, 250);
  l.dragMove(300, 250);
  l.endDrag(); // one drag, however many moves
  const moved = pts(l.selected);
  assert.notDeepEqual(moved, placed);
  l.updateSelected({ color: '#FF0000' });
  l.deleteSelected();
  place(l, 'hline', { x: 100, y: 500 }, { x: 100, y: 500 });
  l.setTool('cursor');
  l.clearAll();
  assert.equal(l.items.length, 0);
  assert.ok(l.undo()); assert.deepEqual(l.items.map((x) => x.type), ['hline'], 'clear all is undone');
  assert.ok(l.undo()); assert.equal(l.items.length, 0, 'the hline is gone again');
  assert.ok(l.undo()); assert.equal(l.items[0].color, '#FF0000', 'the deleted line is back, red');
  assert.ok(l.undo()); assert.notEqual(l.items[0].color, '#FF0000', 'its color is back');
  assert.deepEqual(pts(l.items[0]), moved);
  assert.ok(l.undo()); assert.deepEqual(pts(l.items[0]), placed, 'the drag is undone in one step');
  assert.ok(l.undo()); assert.equal(l.items.length, 0, 'the line was never placed');
  assert.equal(l.undo(), false, 'nothing more to undo');
  assert.ok(l.redo()); assert.ok(l.redo());
  assert.deepEqual(pts(l.items[0]), moved, 'redo puts the drag back');
  l.updateSelected({ width: 3 }); // nothing selected: no change, redo stays
  l.select(l.items[0].id);
  l.updateSelected({ width: 3 });
  assert.equal(l.redo(), false, 'a new change drops what could be redone');
  assert.ok(l.undo()); assert.equal(l.items[0].width, undefined);
});

ok('undo / redo: a burst of typing is one step, a click without moving is none, the selection stays', () => {
  const l = makeLayer();
  const selections = [];
  l.onSelect = (d) => selections.push(d?.text ?? null);
  l.setTool('text');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  for (const text of ['a', 'ab', 'abc']) l.updateSelected({ text });
  l.updateSelected({ color: '#FF0000' }); // another field: its own step
  l.setTool('cursor');
  l.select(d.id);
  assert.ok(l.beginDrag(300, 500));
  l.endDrag(); // a click: nothing moved
  selections.length = 0;
  assert.ok(l.undo());
  assert.equal(l.items[0].text, 'abc');
  assert.notEqual(l.items[0].color, '#FF0000', 'the click added no step: undo took back the color');
  assert.equal(l.selected?.id, d.id, 'the drawing stays selected');
  assert.deepEqual(selections, ['abc'], 'and its toolbar is refreshed');
  assert.ok(l.undo());
  assert.equal(l.items[0].text, TOOLS.text.label, 'the three keystrokes are one step');
  // An edit undone by hand within the burst (lock, unlock) leaves nothing to undo.
  const l2 = makeLayer();
  place(l2, 'trend', { x: 100, y: 300 }, { x: 300, y: 200 });
  l2.toggleLockSelected();
  l2.toggleLockSelected();
  assert.ok(l2.undo());
  assert.equal(l2.items.length, 0, 'the next undo takes back the placing, not an empty step');
  // ...and the same field later on is a step of its own.
  const realNow = Date.now;
  try {
    let now = 1e12;
    Date.now = () => now;
    const l3 = makeLayer();
    l3.setTool('text');
    l3.handleClick({ point: { x: 300, y: 500 } });
    l3.updateSelected({ text: 'one' });
    now += 5000;
    l3.updateSelected({ text: 'two' });
    assert.ok(l3.undo());
    assert.equal(l3.items[0].text, 'one');
  } finally { Date.now = realNow; }
});

ok('undo / redo: while placing, undo drops the drawing in progress; Duplicate and Lock undo too', () => {
  const l = makeLayer();
  place(l, 'trend', { x: 100, y: 300 }, { x: 300, y: 200 });
  l.setTool('trend');
  l.handleClick({ point: { x: 100, y: 100 } }); // first point of a second line
  assert.ok(l.pending);
  assert.equal(l.redo(), false, 'no redo while placing');
  assert.ok(l.undo());
  assert.equal(l.pending, null);
  assert.equal(l.items.length, 1, 'the placed line stays');
  l.setTool('cursor');
  l.select(l.items[0].id);
  l.duplicateSelected();
  l.toggleLockSelected();
  assert.equal(l.selected.locked, true);
  assert.ok(l.undo()); assert.equal(l.items[1].locked, undefined, 'the lock is undone');
  assert.ok(l.undo()); assert.equal(l.items.length, 1, 'the copy is undone');
  assert.equal(l.selected, null, 'the copy was selected: now nothing is');
  // Mid-drag, undo waits.
  l.select(l.items[0].id);
  assert.ok(l.beginDrag(200, 250));
  assert.equal(l.undo(), false);
  l.endDrag();
});

ok('undo / redo: each symbol keeps its own history; the renderer\'s cached fields are no step', () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  try {
    const l = makeLayer();
    place(l, 'trend', { x: 100, y: 300 }, { x: 300, y: 200 });
    l.setContext('OTHER', 1000);
    assert.equal(l.undo(), false, 'nothing drawn on OTHER');
    place(l, 'hline', { x: 100, y: 500 }, { x: 100, y: 500 });
    l.setContext('TEST', 1000);
    assert.equal(l.items.length, 1);
    l.items[0]._w = 42; // what drawing a label caches
    l.select(l.items[0].id);
    l.updateSelected({});
    assert.ok(!mem.get('wickline.drawings.TEST').includes('_w'), 'saved without cached fields');
    assert.ok(l.undo(), 'back on TEST, its history is still there (and the cached field made no step)');
    assert.equal(l.items.length, 0);
    assert.equal(JSON.parse(mem.get('wickline.drawings.TEST')).length, 0, 'and the undo is saved');
    // Another chart changed TEST's drawings meanwhile: this chart's history for it no longer applies.
    const other = makeLayer();
    other.setContext('TEST', 1000);
    place(other, 'hline', { x: 100, y: 500 }, { x: 100, y: 500 });
    l.setContext('OTHER', 1000);
    l.setContext('TEST', 1000);
    assert.equal(l.redo(), false);
    assert.equal(l.undo(), false);
    assert.equal(l.items.length, 1, 'the other chart\'s line is untouched');
  } finally { delete globalThis.localStorage; }
});

ok('undo / redo: the history keeps the last 100 steps', () => {
  const l = makeLayer();
  for (let i = 0; i < 105; i++) place(l, 'hline', { x: 100, y: 100 + i }, { x: 100, y: 100 + i });
  let steps = 0;
  while (l.undo()) steps++;
  assert.equal(steps, 100);
  assert.equal(l.items.length, 5);
});

ok('the tools are registered', () => {
  assert.equal(TOOLS.arrowUp.points, 1);
  assert.equal(TOOLS.arrowDown.points, 1);
});

console.log(`drawings: ${n} checks passed`);
