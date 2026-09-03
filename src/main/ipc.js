'use strict';
// Registers every IPC channel the renderer may call (see preload.js).

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');

function registerIpc({ store, tmdb, library }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(event, ...args) };
      } catch (err) {
        console.error(`[ipc] ${channel} failed:`, err && err.message);
        return { ok: false, error: (err && err.message) || String(err), kind: err && err.kind };
      }
    });

  handle('settings:get', () => store.getSettings());

  handle('settings:save', async (_e, patch) => {
    const before = store.getSettings();
    const after = await store.saveSettings(patch || {});
    if (before.moviesDir !== after.moviesDir) library.refreshWatcher();
    return after;
  });

  handle('store:notices', () => {
    const n = store.notices.splice(0);
    return n;
  });

  handle('dialog:chooseFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose your movies folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('library:get', () => library.publicLibrary());

  handle('library:scan', (_e, opts) => library.scan(opts || {}));

  handle('library:checkFile', (_e, { movieId } = {}) => library.checkFile(movieId));

  handle('tmdb:search', (_e, { query, year } = {}) => tmdb.search(String(query || '').trim(), year || undefined));

  handle('library:fixMatch', (_e, { movieId, tmdbId } = {}) => library.fixMatch(movieId, Number(tmdbId)));

  handle('tmdb:searchTv', (_e, { query, year } = {}) => tmdb.searchTv(String(query || '').trim(), year || undefined));

  handle('library:fixMatchShow', (_e, { showKey, tmdbId } = {}) => library.fixMatchShow(String(showKey), Number(tmdbId)));

  handle('playback:savePosition', (_e, { movieId, position, duration } = {}) =>
    library.savePosition(movieId, position, duration)
  );

  handle('shell:openExternal', async (_e, { movieId } = {}) => {
    const m = store.getMovie(movieId);
    if (!m) throw new Error('Unknown movie');
    const err = await shell.openPath(m.path);
    if (err) throw new Error(err);
    return true;
  });

  handle('shell:revealInFinder', (_e, { movieId } = {}) => {
    const m = store.getMovie(movieId);
    if (!m) throw new Error('Unknown movie');
    shell.showItemInFolder(m.path);
    return true;
  });

  handle('shell:openUrl', (_e, url) => {
    if (/^https:\/\/(www\.)?themoviedb\.org\//.test(String(url))) return shell.openExternal(url);
    throw new Error('URL not allowed');
  });
}

module.exports = { registerIpc };
