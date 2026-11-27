// Updates that install themselves: the installed Windows app and the Linux AppImage (electron-updater,
// reading the latest.yml / latest-linux.yml published with each GitHub release, and checking the
// download's SHA-512 against it). The portable .exe, the .deb and the Mac app can't replace
// themselves (a Mac app would need a paid Apple signature): they keep the "new version" notice and
// its link.
//
// The page decides when: its update check (which the user can turn off) finds a newer version and,
// where this works, asks for it here. The page's calls:
//   update:supported → whether this copy can update itself
//   update:download  → starts downloading; progress and the end come back as update:status events
//   update:install   → restarts into the new version (it also installs when the app is closed)
// Nothing here may stop the app from starting: the updater is loaded only when asked for.

import electron from 'electron'; // the whole module: plain Node (the unit tests) has no named exports for it

/** Where updates come from: the newest published release's files on GitHub. */
export const UPDATE_FEED = 'https://github.com/keptaduona/wickline/releases/latest/download';

/** Whether this copy of the app can install updates itself. */
export function canSelfUpdate(env = process.env, platform = process.platform, packaged = electron?.app?.isPackaged) {
  if (env.WICKLINE_UPDATE_FEED) return true; // a test feed (developers): see below
  if (!packaged) return false;
  if (platform === 'win32') return !env.PORTABLE_EXECUTABLE_DIR; // the portable .exe sets this
  if (platform === 'linux') return !!env.APPIMAGE; // set when running as an AppImage (not the .deb)
  return false;
}

export function setupUpdater({ ipcMain, isAppUrl, getWindow }) {
  let updater = null;
  let status = { state: 'idle' };
  const send = (s) => {
    status = s;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', s);
  };

  const load = async () => {
    if (updater) return updater;
    const mod = await import('electron-updater');
    updater = mod.autoUpdater ?? mod.default?.autoUpdater;
    updater.autoDownload = false; // only when the page asks (its update check is on)
    updater.autoInstallOnAppQuit = true;
    updater.logger = null;
    // The newest release's files, straight from GitHub's "latest" download address (latest.yml or
    // latest-linux.yml, then the file it names), rather than GitHub's "latest release" lookup page, which
    // GitHub sometimes refuses to anonymous requests (a 504 seen on 27 Nov 2026 while the files came fine).
    // WICKLINE_UPDATE_FEED=http://…/ : a local copy of a release's files, to test updating without a release.
    if (process.env.WICKLINE_UPDATE_FEED) updater.forceDevUpdateConfig = true;
    updater.setFeedURL({ provider: 'generic', url: process.env.WICKLINE_UPDATE_FEED || UPDATE_FEED });
    updater.on('download-progress', (p) => send({ ...status, state: 'downloading', percent: Math.floor(p.percent || 0) }));
    updater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
    updater.on('error', (e) => send({ ...status, state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 200) }));
    return updater;
  };

  const fromApp = (e) => isAppUrl(e.senderFrame?.url || '');

  ipcMain.handle('update:supported', (e) => fromApp(e) && canSelfUpdate());

  ipcMain.handle('update:download', async (e) => {
    if (!fromApp(e) || !canSelfUpdate()) return { state: 'unsupported' };
    if (status.state === 'downloading' || status.state === 'ready') return status;
    try {
      const u = await load();
      const r = await u.checkForUpdates();
      const version = r?.updateInfo?.version;
      if (!version || r.isUpdateAvailable === false) { send({ state: 'none' }); return status; }
      send({ state: 'downloading', version, percent: 0 });
      u.downloadUpdate().catch((err) => send({ ...status, state: 'error', error: String(err?.message || err).split('\n')[0].slice(0, 200) }));
    } catch (err) {
      send({ state: 'error', error: String(err?.message || err).split('\n')[0].slice(0, 200) });
    }
    return status;
  });

  ipcMain.handle('update:install', (e) => {
    if (!fromApp(e) || status.state !== 'ready' || !updater) return false;
    setImmediate(() => updater.quitAndInstall(true, true)); // quietly, then start the new version
    return true;
  });
}
