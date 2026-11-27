// Offline UI checks in real Electron windows, including a second process using the saved profile.
// Run: npm run test:e2e:favorites. No live market data or third-party test runner is needed.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const { createRequire } = await import('node:module');
  const { spawn } = await import('node:child_process');
  const { startServer } = await import('../server.mjs');
  const electron = createRequire(import.meta.url)('electron');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'wickline-favorites-'));
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    for (const phase of ['exercise', 'restore']) {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(electron, [file, phase], {
          windowsHide: true, stdio: 'inherit',
          env: { ...process.env, WICKLINE_FAVORITES_PROFILE: profile, WICKLINE_FAVORITES_ORIGIN: `http://127.0.0.1:${port}` },
        });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${phase} timed out`)); }, 120000);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 0, `${phase} failed`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
  }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  app.setPath('userData', process.env.WICKLINE_FAVORITES_PROFILE);
  app.commandLine.appendSwitch('lang', 'en-US');
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const origin = process.env.WICKLINE_FAVORITES_ORIGIN;
    // Keep the actual local app and health detection, but refuse all live data and remote requests.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const u = new URL(details.url);
      callback({ cancel: u.origin !== origin || (u.pathname.startsWith('/api/') && u.pathname !== '/api/health') });
    });
    let failed = 0, passed = 0;
    const check = (name, ok, detail = '') => {
      if (ok) passed++; else failed++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    };
    const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|ERR_ABORTED/.test(e.message)) errors.push(e.message); });
    const run = (code, window = win) => window.webContents.executeJavaScript(code);
    let page = 0;
    const open = async (window = win) => {
      await window.loadURL(`${origin}/?e2e&page=${++page}#s=YAHOO:AAPL&tf=1D`);
      for (let i = 0; i < 100; i++) {
        if (await run(`!!window.__wickline?.views().length && !!document.querySelector('#toolbar [data-more]')`, window)) return;
        await wait(30);
      }
      throw new Error('The app did not initialize');
    };
    const click = (selector, window = win) => run(`document.querySelector(${JSON.stringify(selector)}).click()`, window);
    const tools = (window = win) => run(`[...document.querySelectorAll('#favorite-tools [data-tool]')].map((b) => b.dataset.tool)`, window);
    const menu = () => click('#toolbar [data-more="lines"]');
    const star = (id, window = win) => click(`#tool-menu [data-favorite="${id}"]`, window);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    const drag = async (x, y) => {
      const p = await run(`(() => { const r = document.querySelector('.favorite-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      win.webContents.focus();
      mouse('mouseMove', p.x, p.y); mouse('mouseDown', p.x, p.y); await wait(30);
      mouse('mouseMove', x, y); await wait(30); mouse('mouseUp', x, y); await wait(80);
    };
    const contained = () => run(`(() => { const a = document.querySelector('#charts').getBoundingClientRect(), b = document.querySelector('#favorite-tools').getBoundingClientRect(); return b.left >= a.left && b.top >= a.top && b.right <= a.right + 1 && b.bottom <= a.bottom + 1; })()`);
    try {
      await open();
      if (process.argv.at(-1) === 'restore') {
        check('a new Electron process restores the ordered favorites', JSON.stringify(await tools()) === JSON.stringify(['fib', 'trend', 'hline']));
        check('a new Electron process restores the toolbar position', await run(`(() => { const p = JSON.parse(localStorage.getItem('wickline.favoriteToolsPosition')); const b = document.querySelector('#favorite-tools'); return p.x === 240 && p.y === 140 && b.style.left === '240px' && b.style.top === '140px'; })()`));
        await menu();
        check('menu stars restore with the toolbar', await run(`document.querySelector('[data-favorite="trend"]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-favorite="ray"]').getAttribute('aria-pressed') === 'false'`));
      } else {
        check('an empty profile hides the favorites bar', await run(`document.querySelector('#favorite-tools').hidden`));
        await menu();
        check('each drawing menu entry has a separate, initially hollow star', await run(`document.querySelectorAll('#tool-menu [data-favorite]').length === 5 && [...document.querySelectorAll('#tool-menu [data-favorite]')].every((b) => b.getAttribute('aria-pressed') === 'false' && getComputedStyle(b.querySelector('svg')).fill === 'none')`));
        await star('trend');
        check('starring keeps the menu open and leaves the current tool alone', await run(`!document.querySelector('#tool-menu').hidden && window.__wickline.views()[0].drawings.tool === 'cursor'`));
        check('the filled star and floating bar update immediately', await run(`document.querySelector('[data-favorite="trend"]').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.querySelector('[data-favorite="trend"] svg')).fill !== 'none' && !document.querySelector('#favorite-tools').hidden`) && (await tools()).join() === 'trend');
        await star('ray'); await star('trend');
        check('unstarring removes just that tool without closing the menu', (await tools()).join() === 'ray' && await run(`!document.querySelector('#tool-menu').hidden && document.querySelector('[data-favorite="trend"]').getAttribute('aria-pressed') === 'false'`));
        await star('ray');
        check('removing the last favorite hides the bar', await run(`document.querySelector('#favorite-tools').hidden`));
        await star('trend'); await star('ray');
        await click('#tool-menu [data-pick="ray"]');
        check('normal menu selection still selects a tool and closes the menu', await run(`window.__wickline.views()[0].drawings.tool === 'ray' && document.querySelector('#tool-menu').hidden`));
        await click('#favorite-tools [data-tool="trend"]');
        check('a favorite activates the existing tool with matching sidebar state', await run(`window.__wickline.views()[0].drawings.tool === 'trend' && document.querySelector('#toolbar [data-tool="trend"]').classList.contains('on') && document.querySelector('#favorite-tools [data-tool="trend"]').getAttribute('aria-pressed') === 'true'`));
        check('tooltips reuse the tool name and existing shortcut', await run(`document.querySelector('#favorite-tools [data-tool="trend"]').title === 'Trend line (Alt+T)'`));
        win.webContents.focus();
        for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
        await wait(30);
        check('Escape clears the active favorite with the existing cursor tool', await run(`window.__wickline.views()[0].drawings.tool === 'cursor' && document.querySelectorAll('#favorite-tools .on').length === 0`));
        for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'T', modifiers: ['alt'] });
        await wait(30);
        check('the existing Alt+T shortcut updates the favorite selection', await run(`window.__wickline.views()[0].drawings.tool === 'trend' && document.querySelector('#favorite-tools [data-tool="trend"]').getAttribute('aria-pressed') === 'true'`));
        // Exercise actual pointer capture against a real chart with deterministic candles.
        await run(`(() => { const v = window.__wickline.views()[0]; v.loadGen++; v.feed?.close(); v.feed = { close() {}, canLoadMore: false }; v.bars = Array.from({length: 200}, (_, i) => ({time: 1700000000 + i * 86400, open: 100 + i, high: 104 + i, low: 98 + i, close: 102 + i, volume: 1000})); v.meta = {precision: 2, tzOffset: 0}; v.renderAll(true); v.showError(null); v.q('.overlay.loading').hidden = true; })()`);
        await wait(100);
        const before = await run(`JSON.stringify(window.__wickline.views()[0].chart.timeScale().getVisibleLogicalRange())`);
        await drag(650, 350);
        check('the grip moves the toolbar and saves its new position', await run(`(() => { const p = JSON.parse(localStorage.getItem('wickline.favoriteToolsPosition')); return p.x > 300 && p.y > 150 && !document.querySelector('#favorite-tools').classList.contains('dragging'); })()`));
        check('dragging does not draw or pan the chart', before === await run(`JSON.stringify(window.__wickline.views()[0].chart.timeScale().getVisibleLogicalRange())`) && await run(`window.__wickline.views()[0].drawings.items.length === 0 && window.__wickline.views()[0].drawings.pending === null`));
        await drag(1390, 890);
        check('dragging beyond the bottom/right stays inside the charts', await contained());
        await drag(0, 0);
        check('dragging beyond the top/left stays inside the charts', await contained());
        await run(`(() => { const d = window.__wickline.views()[0].drawings; d.handleClick({point:{x:180,y:120}}); d.handleClick({point:{x:260,y:180}}); })()`);
        check('finishing a drawing clears the favorite highlight with the normal tool lifecycle', await run(`window.__wickline.views()[0].drawings.tool === 'cursor' && window.__wickline.views()[0].drawings.items.length === 1 && document.querySelectorAll('#favorite-tools .on').length === 0`));
        // A second same-origin window receives native storage events (no synthetic sync hook).
        const other = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
        await open(other);
        await menu(); await star('extended'); await wait(100);
        check('favorites sync to another window in real time', (await tools(other)).join() === 'trend,ray,extended');
        await click('#toolbar [data-more="lines"]', other); await star('ray', other); await wait(100);
        check('another window updates both the open menu and bar here', (await tools()).join() === 'trend,extended' && await run(`document.querySelector('[data-favorite="ray"]').getAttribute('aria-pressed') === 'false' && !document.querySelector('#tool-menu').hidden`));
        other.destroy();
        const order = (await tools()).join();
        await click('#layout-btn'); await click('[data-layout="4"]'); await wait(80);
        check('changing layout preserves one shared favorites bar', await run(`document.querySelectorAll('#favorite-tools').length === 1 && window.__wickline.views().length === 4`) && (await tools()).join() === order);
        await run(`window.__wickline.views()[1].el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))`);
        await click('#favorite-tools [data-tool="extended"]');
        check('favorites target the active chart in a multi-chart layout', await run(`window.__wickline.views()[1].drawings.tool === 'extended' && window.__wickline.views()[0].drawings.tool === 'cursor'`));
        await run(`window.__wickline.views()[0].setSymbol('YAHOO:MSFT'); window.__wickline.views()[0].setTimeframe('4h')`);
        check('changing symbol and timeframe preserves favorites', (await tools()).join() === order);
        await click('#layout-btn'); await click('[data-layout="1"]');
        // Include all tools, then narrow the workspace to force a real scrollable overflow.
        await run(`(() => { const ids = ['trend','ray','extended','arrow','channel','hline','hray','vline','avwap','rect','text','arrowUp','arrowDown','fib','measure','long','short']; localStorage.setItem('wickline.favoriteTools', JSON.stringify(ids)); window.dispatchEvent(new StorageEvent('storage', {key:'wickline.favoriteTools'})); })()`);
        win.setSize(520, 600); await wait(160);
        check('many favorites scroll without leaving the workspace', await run(`(() => { const l = document.querySelector('.favorite-list'); return l.scrollWidth > l.clientWidth && l.querySelectorAll('button').length === 17; })()`) && await contained());
        await run(`document.querySelector('.favorite-list').dispatchEvent(new WheelEvent('wheel', {deltaY: 200, bubbles: true, cancelable: true}))`);
        check('the mouse wheel reaches overflowing tools', await run(`document.querySelector('.favorite-list').scrollLeft > 0`));
        await run(`document.querySelector('#favorite-tools [data-tool="short"]').focus()`);
        check('overflowing tools remain reachable by keyboard focus', await run(`document.activeElement.dataset.tool === 'short'`));
        await click('#layout-btn'); await click('[data-layout="4"]'); await wait(100);
        await run(`document.querySelector('#charts').scrollTop = 350`); await wait(100);
        check('the floating bar stays in view while a narrow multi-chart layout scrolls', await run(`document.querySelector('#charts').scrollTop > 0`) && await contained());
        await click('#layout-btn'); await click('[data-layout="1"]'); await wait(100);
        for (const mode of ['dark', 'light']) {
          await run(`document.documentElement.dataset.theme = '${mode}'`);
          check(`${mode} theme uses Wickline's panel color`, await run(`(() => { const b = document.querySelector('#favorite-tools'), p = document.createElement('div'); p.style.background = 'var(--panel)'; document.body.append(p); const same = getComputedStyle(b).backgroundColor === getComputedStyle(p).backgroundColor; p.remove(); return same; })()`));
        }
        win.setSize(1400, 900); await wait(100);
        // Leave an easily checked persisted setup and verify English and Chinese after page reloads.
        await run(`localStorage.setItem('wickline.favoriteTools', JSON.stringify(['fib','trend','hline'])); localStorage.setItem('wickline.favoriteToolsPosition', JSON.stringify({x:240,y:140})); localStorage.setItem('wickline.lang', JSON.stringify('zh-CN'))`);
        await open(); await menu();
        check('Simplified Chinese names, tooltips and star actions are localized', await run(`document.querySelector('#favorite-tools').getAttribute('aria-label') === '常用绘图工具' && document.querySelector('#favorite-tools [data-tool="trend"]').title.includes('趋势线') && document.querySelector('[data-favorite="trend"]').title.includes('取消收藏')`));
        check('a reload restores order and position', (await tools()).join() === 'fib,trend,hline' && await run(`document.querySelector('#favorite-tools').style.left === '240px' && document.querySelector('#favorite-tools').style.top === '140px'`));
        if (process.env.WICKLINE_FAVORITES_SHOT) writeFileSync(process.env.WICKLINE_FAVORITES_SHOT, (await win.webContents.capturePage()).toPNG());
        await run(`localStorage.setItem('wickline.lang', JSON.stringify('en'))`);
        await open();
        check('English labels restore after switching languages', await run(`document.querySelector('#favorite-tools').getAttribute('aria-label') === 'Favorite drawing tools'`));
      }
      check('no application errors in the console', errors.length === 0, errors.join(' | '));
    } catch (e) {
      check('test run', false, e.stack);
    }
    session.defaultSession.flushStorageData();
    await session.defaultSession.cookies.flushStore();
    console.log(`favorite tools UI (${process.argv.at(-1)}): ${passed} passed, ${failed} failed`);
    app.exit(failed ? 1 : 0);
  }).catch((e) => { console.error(e); app.exit(1); });
}
