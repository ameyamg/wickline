// Which copies of the desktop app update themselves (desktop/updater.mjs). Run: node test/updater.test.mjs
// (The download itself, its SHA-512 check and a corrupted download were tried against a local feed.)
import assert from 'node:assert/strict';
import { canSelfUpdate } from '../desktop/updater.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

ok('the installed Windows app and the Linux AppImage update themselves', () => {
  assert.equal(canSelfUpdate({}, 'win32', true), true);
  assert.equal(canSelfUpdate({ APPIMAGE: '/home/me/Wickline-Linux-0.1.12.AppImage' }, 'linux', true), true);
});

ok('the portable .exe, the .deb and the Mac app show the notice with its link instead', () => {
  assert.equal(canSelfUpdate({ PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\me\\Downloads' }, 'win32', true), false);
  assert.equal(canSelfUpdate({}, 'linux', true), false, 'the .deb (no APPIMAGE)');
  assert.equal(canSelfUpdate({}, 'darwin', true), false);
});

ok('not from source (npm start, npm run desktop), unless a test feed is set', () => {
  assert.equal(canSelfUpdate({}, 'win32', false), false);
  assert.equal(canSelfUpdate({ WICKLINE_UPDATE_FEED: 'http://127.0.0.1:9999/' }, 'win32', false), true);
});

console.log(`updater: ${n} checks passed`);
